import {randomBytes, randomUUID} from 'node:crypto';
import {one,all,run,withStore} from './chat-store.mjs';
import {adminCode, clean, digest, equal, fail, handle, hashPassword, newPassword, rate, secret} from './chat-policy.mjs';
import {blocked, disconnect, voice} from './chat-voice.mjs';

const s3=['https://mathscholar.s3.amazonaws.com','https://mathscholar.s3.us-east-1.amazonaws.com'];
const publicUser = u => ({id:u.id,handle:u.handle,label:u.label,admin:!!u.admin,mutedUntil:u.muted});
const day=86400000;
const sessionKey = req => digest(/^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization||'')?.[1] || '');
async function issue(uid) {
  const token=secret();
  await run('DELETE FROM sessions WHERE expires<=?',Date.now());
  await run('INSERT INTO sessions VALUES(?,?,?)',digest(token),uid,Date.now()+day);
  return token;
}
const accountByName = name => one('SELECT * FROM users WHERE handle=?',name);
const getUser = id => one('SELECT * FROM users WHERE id=?',id);
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
    const salt=randomBytes(16).toString('hex'), pass=await hashPassword(password,salt);
    const id=randomUUID(), recovery=randomBytes(18).toString('hex');
    return withStore(true,async()=>{
      if(await accountByName(name))fail(409,'Choose another username.');
      await run('INSERT INTO users(id,handle,label,email,salt,hash,recovery) VALUES(?,?,?,?,?,?,?)',id,name,name,email||null,salt,pass,digest(recovery));
      return {token:await issue(id),user:publicUser(await getUser(id)),recovery};
    });
  }
  rate(action+':'+digest(name.toLowerCase()),16,600000);
  const u=await withStore(false,()=>accountByName(name));
  if(action==='recover'){
    const key=validString(d.recovery,80);
    if(!u || !equal(digest(key),u.recovery))fail(400,'Username or recovery key is incorrect.');
    const salt=randomBytes(16).toString('hex'), pass=await hashPassword(newPassword(d.password),salt);
    const recovery=randomBytes(18).toString('hex');
    return withStore(true,async()=>{
      const changed=await run('UPDATE users SET salt=?,hash=?,recovery=? WHERE id=? AND recovery=?',salt,pass,digest(recovery),u.id,u.recovery);
      if(!changed)fail(409,'Recovery key already used.');
      await run('DELETE FROM sessions WHERE uid=?',u.id);disconnect(u.id);
      return {token:await issue(u.id),user:publicUser(await getUser(u.id)),recovery};
    });
  }
  const pass=await hashPassword(validString(d.password,128),u?.salt || '615cc3e3fbe32cb203883381b790c348');
  if(!u||!equal(pass,u.hash))fail(401,'Username or password is incorrect.');
  return withStore(true,async()=>{
    const current=await getUser(u.id);
    if(!current || current.hash!==u.hash)fail(401,'Username or password is incorrect.');
    return {token:await issue(u.id),user:publicUser(current)};
  });
}
function inbox(uid){
  return all(`SELECT d.id,u.handle,u.label,u.id AS peer FROM dms d JOIN users u ON u.id=CASE WHEN d.a=? THEN d.b ELSE d.a END
    WHERE (d.a=? OR d.b=?) AND NOT EXISTS(SELECT 1 FROM blocks WHERE (owner=? AND target=u.id) OR (owner=u.id AND target=?))
    ORDER BY u.handle`,uid,uid,uid,uid,uid);
}
async function thread(room,user){
  const channel=await one('SELECT kind FROM rooms WHERE id=?',room);
  if(channel?.kind==='text')return;
  const dm=await one('SELECT a,b FROM dms WHERE id=? AND (a=? OR b=?)',room,user.id,user.id);
  if(!dm || await blocked(dm.a,dm.b))fail(404,'Conversation unavailable.');
}
async function profile(u,d){
  const name=validString(d.name,256);
  rate('profile:'+u.id,10,600000);
  if(adminCode.length>=24 && equal(adminCode,name)){
    await run('UPDATE users SET admin=1 WHERE id=?',u.id);
  }else{
    if(d.redeem)fail(403,'Invalid admin code or admin setup is disabled.');
    canSpeak(u);
    const label=clean(name,'name',24);
    await run('UPDATE users SET label=? WHERE id=?',label,u.id);
  }
  return {user:publicUser(await getUser(u.id))};
}
async function messages(room,u,d){
  await thread(room,u);
  if(!d) return {messages:await all('SELECT m.id,m.uid,m.label,u.handle,m.text,m.time FROM msgs m LEFT JOIN users u ON u.id=m.uid WHERE m.room=? ORDER BY m.time,m.rowid',room)};
  canSpeak(u);
  const text=clean(d.text,'message',1200), nonce=validString(d.nonce,48);
  if(!/^[a-z0-9-]{20,48}$/i.test(nonce))fail(400,'Invalid message ID.');
  const previous=await one('SELECT id FROM msgs WHERE room=? AND uid=? AND nonce=?',room,u.id,nonce);
  if(previous)return previous;
  rate('send:'+u.id,20);
  const id=randomUUID();
  await run('INSERT INTO msgs VALUES(?,?,?,?,?,?,?)',id,room,u.id,u.label,text,Date.now(),nonce);
  await run('DELETE FROM msgs WHERE room=? AND rowid NOT IN(SELECT rowid FROM msgs WHERE room=? ORDER BY time DESC,rowid DESC LIMIT 150)',room,room);
  return {id};
}
async function route(action,method,u,d,key) {
  const uid=u.id;
  if(method==='GET'){
    if(action==='home')return {user:publicUser(u), rooms:await all('SELECT * FROM rooms ORDER BY rowid'),dms:await inbox(uid),
      blocks:await all('SELECT u.id,u.handle FROM blocks b JOIN users u ON b.target=u.id WHERE b.owner=?',uid)};
    if(/^messages\/[\w-]+$/.test(action))return messages(action.slice(9),u);
    if(action==='reports'){requireAdmin(u);return {reports:await all('SELECT * FROM reports ORDER BY time DESC LIMIT 100')};}
    fail(404,'Chat endpoint not found.');
  }
  if(action==='logout'){await run('DELETE FROM sessions WHERE hash=?',key);disconnect(uid,key);return {};}
  if(action==='profile')return profile(u,d);
  if(action==='rooms'){
    requireAdmin(u);canSpeak(u);const name=clean(d.name,'channel name',32);
    if(!['text','voice'].includes(d.kind))fail(400,'Choose text or voice.');
    if((await one('SELECT count(*) AS n FROM rooms')).n>=100)fail(409,'Channel limit reached.');
    const id=randomUUID();
    if(!await run('INSERT OR IGNORE INTO rooms VALUES(?,?,?)',id,name,d.kind))fail(409,'That channel name is taken.');
    return {id};
  }
  if(action==='dm'){
    canSpeak(u);rate('dm:'+uid,30);
    const peer=await accountByName(validString(d.handle,24));
    if(!peer || peer.id===uid || await blocked(uid,peer.id))fail(404,'That conversation is unavailable.');
    const [a,b]=[uid,peer.id].sort();
    await run('INSERT OR IGNORE INTO dms VALUES(?,?,?)',randomUUID(),a,b);
    return await one('SELECT id FROM dms WHERE a=? AND b=?',a,b);
  }
  if(action==='block' || action==='unblock'){
    const target=validString(d.target);
    if(!await getUser(target)||target===uid)fail(404,'Account unavailable.');
    if(action==='block')await run('INSERT OR IGNORE INTO blocks VALUES(?,?)',uid,target);
    else await run('DELETE FROM blocks WHERE owner=? AND target=?',uid,target);
    return {};
  }
  if(/^messages\/[\w-]+$/.test(action))return messages(action.slice(9),u,d);
  if(action.startsWith('voice/'))return voice(action.slice(6),u,key,d);
  if(action==='report'){
    rate('report:'+uid,10,600000);
    const room=validString(d.room), id=validString(d.message);
    let target,detail;
    if(id==='voice'){
      const snapshot=await voice('poll',u,key,{ticket:d.ticket});
      const person=snapshot.peers.find(p=>p.id===d.target);
      if(!person)fail(404,'Voice participant unavailable.');
      target=person.id;detail='Live voice report about @'+(await getUser(target)).handle;
    }else{
      await thread(room,u);const msg=await one('SELECT * FROM msgs WHERE id=? AND room=?',id,room);
      if(!msg)fail(404,'Message unavailable.');target=msg.uid;detail=msg.label+' · '+msg.text;
    }
    if(target===uid)fail(400,'Choose another participant.');
    await run('INSERT OR IGNORE INTO reports VALUES(?,?,?,?,?,?)',randomUUID(),uid,target,detail,id,Date.now());return {};
  }
  if(action==='moderate'){
    requireAdmin(u);const r=await one('SELECT * FROM reports WHERE id=?',validString(d.report));
    if(!r)fail(404,'Report already resolved.');
    if(d.decision==='mute'){
      const target=await getUser(r.target);
      if(!target || target.admin)fail(400,'This account cannot be muted.');
      await run('UPDATE users SET muted=? WHERE id=?',Date.now()+day,target.id);disconnect(target.id);
    }else if(d.decision==='remove'){
      if(r.message==='voice')fail(400,'Choose mute or dismiss for a voice report.');
      await run('DELETE FROM msgs WHERE id=?',r.message);
    }else if(d.decision!=='dismiss')fail(400,'Unknown moderation action.');
    await run('DELETE FROM reports WHERE id=?',r.id);return {};
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
    if(!/^Bearer [0-9a-f]{64}$/.test(req.headers.authorization||''))fail(401,'Sign in to Goop Chat.');
    const key=sessionKey(req);
    const data=req.method==='POST'?await body(req):null;
    const write=req.method==='POST' && !action.startsWith('voice/');
    const result=await withStore(write,async()=>{
      const current=await one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.uid WHERE s.hash=? AND s.expires>?',key,Date.now());
      if(!current)fail(401,'Sign in to Goop Chat.');
      return route(action,req.method,current,data,key);
    });
    return reply(200,result);
  }catch(e){
    if(!e.status)console.error('Chat storage or request failed:',e.code||e.name);
    if(!res.destroyed)reply(e.status||503,{error:e.status?e.message:'Chat storage is unavailable. Please try again.'});
  }
}
