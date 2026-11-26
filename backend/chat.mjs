import {randomBytes, randomUUID} from 'node:crypto';
import {db,transaction} from './chat-store.mjs';
import {adminCode, clean, digest, equal, fail, handle, hashPassword, newPassword, rate, secret} from './chat-policy.mjs';
import {blocked, disconnect, voice} from './chat-voice.mjs';

const s3=['https://mathscholar.s3.amazonaws.com','https://mathscholar.s3.us-east-1.amazonaws.com'];
const publicUser = u => ({id:u.id,handle:u.handle,label:u.label,admin:!!u.admin,mutedUntil:u.muted});
const day=86400000;
const sessionKey = req => digest(/^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization||'')?.[1] || '');
function issue(uid) {
  const token=secret();
  db().prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
  db().prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),uid,Date.now()+day);
  return token;
}
const accountByName = name => db().prepare('SELECT * FROM users WHERE handle=?').get(name);
const getUser = id => db().prepare('SELECT * FROM users WHERE id=?').get(id);
function canSpeak(u){ if(u.muted>Date.now()) fail(403,'Your account is muted until '+new Date(u.muted).toUTCString()+'.'); }
function requireAdmin(u){ if(!u.admin)fail(403,'Channel admin access is required.'); }
function validString(v,n=120){if(typeof v!=='string'||!v.length||v.length>n)fail(400,'Invalid input.');return v;}
async function body(req){
  if(req.headers['content-type']?.split(';')[0]!=='application/json')fail(415,'Use JSON.');
  let bytes=0;const pieces=[];
  for await(const chunk of req){bytes+=chunk.length;if(bytes>26000)fail(413,'Request too large.');pieces.push(chunk);}
  let obj;try{obj=JSON.parse(Buffer.concat(pieces).toString());}catch{}
  if(!obj||typeof obj!=='object'||Array.isArray(obj))fail(400,'Invalid request.');
  return obj;
}
async function auth(action,d,ip){
  const name=action==='signup'?handle(d.name):validString(d.name,24);
  rate('auth-ip:'+ip,150,600000);
  if(action==='signup'){
    rate('register:'+ip,12,600000);
    const email=typeof d.email==='string'?d.email.trim():'';
    if(email && (email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))fail(400,'Enter a valid email address or leave it blank.');
    const password=newPassword(d.password);
    if(accountByName(name))fail(409,'Choose another username.');
    const salt=randomBytes(16).toString('hex'), pass=await hashPassword(password,salt);
    const id=randomUUID(), recovery=randomBytes(18).toString('hex');
    return transaction(()=>{
      if(accountByName(name))fail(409,'Choose another username.');
      db().prepare('INSERT INTO users(id,handle,label,email,salt,hash,recovery) VALUES(?,?,?,?,?,?,?)').run(id,name,name,email||null,salt,pass,digest(recovery));
      return {token:issue(id),user:publicUser(getUser(id)),recovery};
    });
  }
  rate(action+':'+digest(name.toLowerCase()),16,600000);
  const u=accountByName(name);
  if(action==='recover'){
    const key=validString(d.recovery,80);
    if(!u || !equal(digest(key),u.recovery))fail(400,'Username or recovery key is incorrect.');
    const salt=randomBytes(16).toString('hex'), pass=await hashPassword(newPassword(d.password),salt);
    const recovery=randomBytes(18).toString('hex');
    return transaction(()=>{
      const changed=db().prepare('UPDATE users SET salt=?,hash=?,recovery=? WHERE id=? AND recovery=?').run(salt,pass,digest(recovery),u.id,u.recovery);
      if(!changed.changes)fail(409,'Recovery key already used.');
      db().prepare('DELETE FROM sessions WHERE uid=?').run(u.id);disconnect(u.id);
      return {token:issue(u.id),user:publicUser(getUser(u.id)),recovery};
    });
  }
  const pass=await hashPassword(validString(d.password,128),u?.salt || '615cc3e3fbe32cb203883381b790c348');
  if(!u||!equal(pass,u.hash)||getUser(u.id).hash!==u.hash)fail(401,'Username or password is incorrect.');
  return {token:issue(u.id),user:publicUser(getUser(u.id))};
}
function inbox(uid){
  return db().prepare(`SELECT d.id,u.handle,u.label,u.id AS peer FROM dms d JOIN users u ON u.id=CASE WHEN d.a=? THEN d.b ELSE d.a END
    WHERE (d.a=? OR d.b=?) AND NOT EXISTS(SELECT 1 FROM blocks WHERE (owner=? AND target=u.id) OR (owner=u.id AND target=?))
    ORDER BY u.handle`).all(uid,uid,uid,uid,uid);
}
function thread(room,user){
  const channel=db().prepare('SELECT kind FROM rooms WHERE id=?').get(room);
  if(channel?.kind==='text')return;
  const dm=db().prepare('SELECT a,b FROM dms WHERE id=? AND (a=? OR b=?)').get(room,user.id,user.id);
  if(!dm || blocked(dm.a,dm.b))fail(404,'Conversation unavailable.');
}
function profile(u,d){
  const name=validString(d.name,256);
  rate('profile:'+u.id,10,600000);
  if(adminCode.length>=24 && equal(adminCode,name)){
    db().prepare('UPDATE users SET admin=1 WHERE id=?').run(u.id);
  }else{
    if(d.redeem)fail(403,'Invalid admin code or admin setup is disabled.');
    canSpeak(u);
    const label=clean(name,'name',24);
    db().prepare('UPDATE users SET label=? WHERE id=?').run(label,u.id);
  }
  return {user:publicUser(getUser(u.id))};
}
function messages(room,u,d){
  thread(room,u);
  if(!d) return {messages:db().prepare('SELECT m.id,m.uid,m.label,u.handle,m.text,m.time FROM msgs m LEFT JOIN users u ON u.id=m.uid WHERE m.room=? ORDER BY m.time,m.rowid').all(room)};
  canSpeak(u);
  const text=clean(d.text,'message',1200), nonce=validString(d.nonce,48);
  if(!/^[a-z0-9-]{20,48}$/i.test(nonce))fail(400,'Invalid message ID.');
  const previous=db().prepare('SELECT id FROM msgs WHERE room=? AND uid=? AND nonce=?').get(room,u.id,nonce);
  if(previous)return previous;
  rate('send:'+u.id,20);
  return transaction(()=>{
    const id=randomUUID();
    db().prepare('INSERT INTO msgs VALUES(?,?,?,?,?,?,?)').run(id,room,u.id,u.label,text,Date.now(),nonce);
    db().prepare('DELETE FROM msgs WHERE room=? AND rowid NOT IN(SELECT rowid FROM msgs WHERE room=? ORDER BY time DESC,rowid DESC LIMIT 150)').run(room,room);
    return {id};
  });
}
function route(action,method,u,d,key) {
  const uid=u.id;
  if(method==='GET'){
    if(action==='home')return {user:publicUser(u), rooms:db().prepare('SELECT * FROM rooms ORDER BY rowid').all(),dms:inbox(uid),
      blocks:db().prepare('SELECT u.id,u.handle FROM blocks b JOIN users u ON b.target=u.id WHERE b.owner=?').all(uid)};
    if(/^messages\/[\w-]+$/.test(action))return messages(action.slice(9),u);
    if(action==='reports'){requireAdmin(u);return {reports:db().prepare('SELECT * FROM reports ORDER BY time DESC LIMIT 100').all()};}
    fail(404,'Chat endpoint not found.');
  }
  if(action==='logout'){db().prepare('DELETE FROM sessions WHERE hash=?').run(key);disconnect(uid,key);return {};}
  if(action==='profile')return profile(u,d);
  if(action==='rooms'){
    requireAdmin(u);canSpeak(u);const name=clean(d.name,'channel name',32);
    if(!['text','voice'].includes(d.kind))fail(400,'Choose text or voice.');
    if(db().prepare('SELECT count(*) AS n FROM rooms').get().n>=100)fail(409,'Channel limit reached.');
    const id=randomUUID();
    if(!db().prepare('INSERT OR IGNORE INTO rooms VALUES(?,?,?)').run(id,name,d.kind).changes)fail(409,'That channel name is taken.');
    return {id};
  }
  if(action==='dm'){
    canSpeak(u);rate('dm:'+uid,30);
    const peer=accountByName(validString(d.handle,24));
    if(!peer || peer.id===uid || blocked(uid,peer.id))fail(404,'That conversation is unavailable.');
    const [a,b]=[uid,peer.id].sort();
    db().prepare('INSERT OR IGNORE INTO dms VALUES(?,?,?)').run(randomUUID(),a,b);
    return db().prepare('SELECT id FROM dms WHERE a=? AND b=?').get(a,b);
  }
  if(action==='block' || action==='unblock'){
    const target=validString(d.target);
    if(!getUser(target)||target===uid)fail(404,'Account unavailable.');
    if(action==='block')db().prepare('INSERT OR IGNORE INTO blocks VALUES(?,?)').run(uid,target);
    else db().prepare('DELETE FROM blocks WHERE owner=? AND target=?').run(uid,target);
    return {};
  }
  if(/^messages\/[\w-]+$/.test(action))return messages(action.slice(9),u,d);
  if(action.startsWith('voice/'))return voice(action.slice(6),u,key,d);
  if(action==='report'){
    rate('report:'+uid,10,600000);
    const room=validString(d.room), id=validString(d.message);
    let target,detail;
    if(id==='voice'){
      const person=voice('poll',u,key,{ticket:d.ticket}).peers.find(p=>p.id===d.target);
      if(!person)fail(404,'Voice participant unavailable.');
      target=person.id;detail='Live voice report about @'+getUser(target).handle;
    }else{
      thread(room,u);const msg=db().prepare('SELECT * FROM msgs WHERE id=? AND room=?').get(id,room);
      if(!msg)fail(404,'Message unavailable.');target=msg.uid;detail=msg.label+' · '+msg.text;
    }
    if(target===uid)fail(400,'Choose another participant.');
    db().prepare('INSERT OR IGNORE INTO reports VALUES(?,?,?,?,?,?)').run(randomUUID(),uid,target,detail,id,Date.now());return {};
  }
  if(action==='moderate'){
    requireAdmin(u);const r=db().prepare('SELECT * FROM reports WHERE id=?').get(validString(d.report));
    if(!r)fail(404,'Report already resolved.');
    return transaction(()=>{
      if(d.decision==='mute'){
        const target=getUser(r.target);
        if(!target || target.admin)fail(400,'This account cannot be muted.');
        db().prepare('UPDATE users SET muted=? WHERE id=?').run(Date.now()+day,target.id);disconnect(target.id);
      }else if(d.decision==='remove'){
        if(r.message==='voice')fail(400,'Choose mute or dismiss for a voice report.');
        db().prepare('DELETE FROM msgs WHERE id=?').run(r.message);
      }else if(d.decision!=='dismiss')fail(400,'Unknown moderation action.');
      db().prepare('DELETE FROM reports WHERE id=?').run(r.id);return {};
    });
  }
  fail(404,'Chat endpoint not found.');
}
export async function chat(req,res,pathname,origins){
  function reply(status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));}
  try{
    const origin=req.headers.origin;
    const legacy=origins.length===1&&origins[0]==='https://mathscholar.s3.us-east-2.amazonaws.com'&&s3.includes(origin);
    if(origin&&!legacy&&!origins.includes(origin)&&!origins.includes('*')){
      let same=false;try{const url=new URL(origin);same=['http:','https:'].includes(url.protocol)&&url.host===req.headers.host;}catch{}
      if(!same)fail(403,'This site is not enabled for chat.');
    }
    if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(!['GET','POST'].includes(req.method))fail(405,'Method not allowed.');
    const action=pathname.slice('/api/chat/'.length);
    if(['signup','signin','recover'].includes(action)&&req.method==='POST')
      return reply(200,await auth(action,await body(req),req.socket.remoteAddress));
    const key=sessionKey(req);
    const u=db().prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.uid WHERE s.hash=? AND s.expires>?').get(key,Date.now());
    if(!u)fail(401,'Sign in to Goop Chat.');
    const data=req.method==='POST'?await body(req):null;
    // Body reads can yield to another request that mutes the account or ends the session.
    const current=data?db().prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.uid WHERE s.hash=? AND s.expires>?').get(key,Date.now()):u;
    if(!current)fail(401,'Sign in to Goop Chat.');
    return reply(200,route(action,req.method,current,data,key));
  }catch(e){
    if(!e.status)console.error('Chat storage or request failed:',e.code||e.name);
    if(!res.destroyed)reply(e.status||503,{error:e.status?e.message:'Chat storage is unavailable. Please try again.'});
  }
}
