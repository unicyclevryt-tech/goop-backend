import { invitation, playerRoute } from './player.mjs';
import {randomBytes, randomUUID} from 'node:crypto';
import {bridgeConfig, queueDiscordMessage} from './discord-bridge.mjs';
import {one,all,run,withStore,trimMessages} from './chat-store.mjs';
import {clean, digest, equal, fail, handle, hashPassword, newPassword, permissions, rate, secret, staffRanks} from './chat-policy.mjs';
import {beginCodeLogin, useContinuation, openVisit, connectVisit, hasVisit, closeVisit, endAccountVisits, currentlyAdmin} from './chat-visit.mjs';
import {blocked, disconnect, voice} from './chat-voice.mjs';

const s3=['https://mathscholar.s3.amazonaws.com','https://mathscholar.s3.us-east-1.amazonaws.com'];
// admin: whether staff tools are shown. staff: rank number (see staffRanks). perms: what this rank may do.
const publicUser = (u,level=0) => ({id:u.id,handle:u.handle,label:u.label,admin:level>0,staff:level,rank:staffRanks[level]||'',
  perms:permissions(level),mutedUntil:u.muted});
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
const forever=253402300799000; // a mute that never ends (the year 9999)
function canSpeak(u){
  if(u.muted>=forever) fail(403,'Your account is muted permanently.');
  if(u.muted>Date.now()) fail(403,'Your account is muted until '+new Date(u.muted).toUTCString()+'.');
}
async function isBanned(uid){
  const ban=await one('SELECT until FROM bans WHERE uid=?',uid);
  if(!ban || (ban.until && ban.until<=Date.now()))return null;
  return ban;
}
const banMessage = ban => ban.until ? 'This account is banned from Goop Chat until '+new Date(ban.until).toUTCString()+'.' : 'This account is banned from Goop Chat.';
const staffRoom = room => one('SELECT 1 AS staff FROM staff_rooms WHERE room=?',room);
// A locked channel accepts posts from the admin who locked it and from members of its posting roles.
async function canPostIn(room,channel,u){
  if(!channel?.owner)return true;
  if(channel.owner===u.id && u.staff>=4)return true;
  return !!await one(`SELECT 1 AS ok FROM channel_post_roles c JOIN member_roles m ON m.role=c.role
    WHERE c.room=? AND m.uid=?`,room,u.id);
}
function requireAdmin(u){ if(!u.admin)fail(403,'Channel admin access is required.'); }
function requirePerm(u,perm){ if(!permissions(u.staff||0)[perm])fail(403,'Your staff rank cannot do that.'); }
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
  rate('auth-ip:'+ip,150,600000);
  if(action==='signin' && !d.continuation){
    const input=validString(d.name,256);
    const continuation=beginCodeLogin(input);
    if(continuation)return {continuation};
    if(input.length>24)fail(401,'Username or password is incorrect.');
  }
  const name=action==='signup'?handle(d.name):validString(d.name,24);
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
      await run('DELETE FROM sessions WHERE uid=?',u.id);disconnect(u.id);endAccountVisits(u.id);
      return {token:await issue(u.id),user:publicUser(await getUser(u.id)),recovery};
    });
  }
  const pass=await hashPassword(validString(d.password,128),u?.salt || '615cc3e3fbe32cb203883381b790c348');
  if(!u||!equal(pass,u.hash))fail(401,'Username or password is incorrect.');
  const level=d.continuation ? useContinuation(d.continuation) : 0;
  const login=await withStore(true,async()=>{
    const current=await getUser(u.id);
    if(!current || current.hash!==u.hash)fail(401,'Username or password is incorrect.');
    const ban=await isBanned(current.id);if(ban)fail(403,banMessage(ban));
    if(d.continuation)canSpeak(current);
    return {token:await issue(u.id),user:publicUser(current)};
  });
  if(level){
    login.visit=openVisit(login.token,u.id,level);
    login.user=publicUser(login.user,level);
  }
  return login;
}
function inbox(uid){
  return all(`SELECT d.id,u.handle,u.label,u.id AS peer FROM dms d JOIN users u ON u.id=CASE WHEN d.a=? THEN d.b ELSE d.a END
    WHERE (d.a=? OR d.b=?) AND NOT EXISTS(SELECT 1 FROM blocks WHERE (owner=? AND target=u.id) OR (owner=u.id AND target=?))
    ORDER BY u.handle`,uid,uid,uid,uid,uid);
}
async function thread(room,user){
  const channel=await one('SELECT r.kind,l.owner FROM rooms r LEFT JOIN channel_locks l ON l.room=r.id WHERE r.id=?',room);
  if(channel && await staffRoom(room) && !permissions(user.staff||0).modChannels)fail(404,'Conversation unavailable.');
  if(channel?.kind==='text')return channel;
  const dm=await one('SELECT a,b FROM dms WHERE id=? AND (a=? OR b=?)',room,user.id,user.id);
  if(!dm || await blocked(dm.a,dm.b))fail(404,'Conversation unavailable.');
}
async function profile(u,d){
  rate('profile:'+u.id,10,600000);
  if(d.redeem)fail(400,'Invalid display name request.');
  canSpeak(u);
  const label=clean(d.name,'name',24);
  await run('UPDATE users SET label=? WHERE id=?',label,u.id);
  return {user:publicUser({...u,label},u.staff||0)};
}
async function messages(room,u,d){
  const channel=await thread(room,u);
  if(!d){
    const rows=await all(`WITH author_roles AS (
      SELECT mr.uid,r.name FROM member_roles mr JOIN roles r ON r.id=mr.role
      WHERE mr.uid IN (SELECT DISTINCT uid FROM msgs WHERE room=?) ORDER BY mr.uid,r.name
    ), badges AS (SELECT uid,group_concat(name) AS names FROM author_roles GROUP BY uid)
    SELECT m.id,m.uid,m.label,u.handle,m.text,m.time,b.names,i.invite,link.reply_to,original.label AS replyLabel,original.text AS replyText FROM msgs m LEFT JOIN game_invites i ON i.message_id=m.id
    LEFT JOIN users u ON u.id=m.uid LEFT JOIN badges b ON b.uid=m.uid
    LEFT JOIN discord_links link ON link.goop_id=m.id
    LEFT JOIN discord_links parent ON parent.channel=link.channel AND parent.discord_id=link.reply_to
    LEFT JOIN msgs original ON original.id=parent.goop_id AND original.room=m.room
    WHERE m.room=? ORDER BY m.time,m.rowid`,room,room);
    return {messages:rows.map(({names,invite,reply_to,replyLabel,replyText,...message})=>{
      if(reply_to){
        const preview=replyText?.replace(/\s+/g,' ').slice(0,100);
        const prefix=replyLabel ? 'Reply to '+replyLabel+' (“'+preview+'”)' : 'Discord reply';
        message.text=prefix+' — '+message.text;
      }
      return {...message,...(invite?{invite:JSON.parse(invite)}:{}),roles:names?names.split(','):[]};
    })};
  }
  canSpeak(u);
  const card=d.invite ? invitation(d.invite) : null;
  const text=clean(card?'Play '+card.name:d.text,'message',1200), nonce=validString(d.nonce,48);
  if(!/^[a-z0-9-]{20,48}$/i.test(nonce))fail(400,'Invalid message ID.');
  const previous=await one('SELECT id FROM msgs WHERE room=? AND uid=? AND nonce=?',room,u.id,nonce);
  if(previous)return previous;
  if(!await canPostIn(room,channel,u))fail(403,'This channel is read-only.');
  rate('send:'+u.id,20);
  const id=randomUUID();
  await run('INSERT INTO msgs VALUES(?,?,?,?,?,?,?)',id,room,u.id,u.label,text,Date.now(),nonce);
  if(card)await run('INSERT INTO game_invites(message_id,invite) VALUES(?,?)',id,JSON.stringify(card));
  if(channel?.kind==='text')await queueDiscordMessage(room,id);
  await trimMessages(room);
  return {id};
}
async function setChannelLock(room,u,locked){
  if(typeof locked!=='boolean')fail(400,'Choose a channel lock setting.');
  const channel=await one(`SELECT r.kind,l.owner FROM rooms r LEFT JOIN channel_locks l ON l.room=r.id
    WHERE r.id=?`,room);
  if(channel?.kind!=='text')fail(400,'Choose a text channel.');
  // The owner key can change any lock; co-owners only their own.
  if(channel.owner && channel.owner!==u.id && u.staff<5)fail(403,'Only the person who locked this channel can change it.');
  if(locked)await run('INSERT OR IGNORE INTO channel_locks(room,owner) VALUES(?,?)',room,u.id);
  else await run('DELETE FROM channel_locks WHERE room=?',room);
  return {};
}
async function changeMemberRole(d){
  if(typeof d.assigned!=='boolean')fail(400,'Choose whether to give or remove the role.');
  const member=await accountByName(validString(d.handle,24));
  if(!member)fail(404,'No account has that username.');
  const role=await one('SELECT id,name FROM roles WHERE id=?',validString(d.role));
  if(!role)fail(404,'Role unavailable.');
  if(d.assigned)await run('INSERT OR IGNORE INTO member_roles(uid,role) VALUES(?,?)',member.id,role.id);
  else await run('DELETE FROM member_roles WHERE uid=? AND role=?',member.id,role.id);
  return {handle:member.handle,role:role.name};
}
async function withPosting(u,home){
  const postRoles=await all('SELECT c.room,r.id,r.name FROM channel_post_roles c JOIN roles r ON r.id=c.role ORDER BY r.name');
  const mine=new Set((await all('SELECT role FROM member_roles WHERE uid=?',u.id)).map(r=>r.role));
  const staffOnly=new Set((await all('SELECT room FROM staff_rooms')).map(r=>r.room));
  const seeStaff=permissions(u.staff||0).modChannels;
  // Database rows can be read-only, so build plain objects.
  home.rooms=home.rooms.filter(room=>seeStaff || !staffOnly.has(room.id)).map(room=>{
    const roles=postRoles.filter(p=>p.room===room.id);
    return {...room,staffOnly:staffOnly.has(room.id),postRoles:roles.map(({id,name})=>({id,name})),
      canPost:room.kind==='text' && (!room.lockOwner || (room.lockOwner===u.id && u.staff>=4) || roles.some(r=>mine.has(r.id)))};
  });
  return home;
}
async function memberTarget(d){
  const target=typeof d.target==='string' ? await getUser(validString(d.target,80)) : await accountByName(validString(d.handle,24));
  if(!target)fail(404,'No account has that username.');
  return target;
}
const maxTimeout=40320; // 28 days, in minutes
// Staff moderation of one account. Each action needs a rank (see permissions in chat-policy.mjs).
async function moderateMember(u,d){
  const target=await memberTarget(d);
  const name=target.handle ? '@'+target.handle : target.label;
  const perms=permissions(u.staff||0);
  const need=perm=>{if(!perms[perm])fail(403,'Your staff rank cannot do that.');};
  if(['mute','kick','ban'].includes(d.action)){
    if(target.id===u.id)fail(400,'You cannot moderate your own account.');
    // Staff can only act on people below their own rank while that person is signed in with a key.
    if(currentlyAdmin(target.id)>=u.staff)fail(400,'This account has the same or a higher staff rank.');
  }
  if(d.action==='mute'){
    const minutes=d.minutes;
    if(minutes==='forever')need('permBan');
    else if(!(Number.isInteger(minutes) && minutes>=1 && minutes<=maxTimeout))fail(400,'Choose a timeout of up to 28 days.');
    else need('timeout');
    await run('UPDATE users SET muted=? WHERE id=?',minutes==='forever'?forever:Date.now()+minutes*60000,target.id);
    disconnect(target.id);
    return {message:name+(minutes==='forever'?' is muted permanently.':' is timed out.')};
  }
  if(d.action==='unmute'){need('timeout');await run('UPDATE users SET muted=0 WHERE id=?',target.id);return {message:name+' can chat again.'};}
  if(d.action==='kick'){
    need('kick');
    await run('DELETE FROM sessions WHERE uid=?',target.id);
    disconnect(target.id);endAccountVisits(target.id);
    return {message:name+' was kicked. They can sign in again.'};
  }
  if(d.action==='ban'){
    const days=d.days;
    if(days===undefined || days===null)need('permBan');
    else if(!(Number.isInteger(days) && days>=1 && days<=365))fail(400,'Choose a ban of 1 to 365 days.');
    else need('tempBan');
    if(d.purge===true)need('permBan');
    const until=days ? Date.now()+days*day : null;
    await run('INSERT OR REPLACE INTO bans(uid,by_user,time,until) VALUES(?,?,?,?)',target.id,u.id,Date.now(),until);
    await run('DELETE FROM sessions WHERE uid=?',target.id);
    if(d.purge===true)await run('DELETE FROM msgs WHERE uid=?',target.id);
    disconnect(target.id);endAccountVisits(target.id);
    return {message:name+(days?' is banned for '+days+' day'+(days>1?'s':''):' is banned permanently')+(d.purge===true?' and their messages were deleted.':'.')};
  }
  if(d.action==='unban'){
    const ban=await one('SELECT until FROM bans WHERE uid=?',target.id);
    need(ban && !ban.until ? 'permBan' : 'tempBan');
    await run('DELETE FROM bans WHERE uid=?',target.id);return {message:name+' is no longer banned.'};
  }
  fail(400,'Unknown moderation action.');
}
async function moderationList(){
  return {
    banned:await all(`SELECT u.id,u.handle,u.label,b.time,b.until FROM bans b JOIN users u ON u.id=b.uid
      WHERE b.until IS NULL OR b.until>? ORDER BY b.time DESC LIMIT 200`,Date.now()),
    muted:await all(`SELECT id,handle,label,muted FROM users WHERE muted>? ORDER BY muted LIMIT 200`,Date.now()),
  };
}
async function deleteMessage(u,d){
  const room=validString(d.room), id=validString(d.message,80);
  await thread(room,u);
  const msg=await one('SELECT uid FROM msgs WHERE id=? AND room=?',id,room);
  if(!msg)fail(404,'Message unavailable.');
  if(msg.uid!==u.id && !permissions(u.staff||0).deleteAny)fail(403,'You can only delete your own messages.');
  await run('DELETE FROM msgs WHERE id=?',id);
  await run('DELETE FROM reports WHERE message=?',id);
  return {};
}
async function channelSettings(u,d){
  const room=validString(d.room);
  if(typeof d.locked!=='boolean')fail(400,'Choose who can post.');
  const roles=Array.isArray(d.roles)?d.roles:[];
  if(roles.length>50 || roles.some(r=>typeof r!=='string'))fail(400,'Invalid roles.');
  await setChannelLock(room,u,d.locked);
  if(typeof d.staffOnly==='boolean'){
    if(d.staffOnly)await run('INSERT OR IGNORE INTO staff_rooms(room) VALUES(?)',room);
    else await run('DELETE FROM staff_rooms WHERE room=?',room);
  }
  await run('DELETE FROM channel_post_roles WHERE room=?',room);
  for(const role of new Set(roles)){
    if(!await one('SELECT 1 AS ok FROM roles WHERE id=?',role))fail(404,'Role unavailable.');
    await run('INSERT INTO channel_post_roles(room,role) VALUES(?,?)',room,role);
  }
  return {};
}
async function route(action,method,u,d,key) {
  const uid=u.id;
  if (['player-items','game-report','game-reports'].includes(action)) return playerRoute(action,method,u,d);
  if(method==='GET'){
    if(action==='home')return withPosting(u,{user:publicUser(u,u.staff||0), rooms:await all(`SELECT r.id,CASE WHEN r.kind='text' AND r.id=? AND r.id<>'discord' THEN r.name || ' (Discord)' ELSE r.name END AS name,r.kind,l.owner AS lockOwner,p.handle AS lockHandle
      FROM rooms r LEFT JOIN channel_locks l ON l.room=r.id LEFT JOIN users p ON p.id=l.owner ORDER BY r.rowid`,bridgeConfig()?.room || ''),dms:await inbox(uid),
      myRoles:await all('SELECT r.name FROM member_roles m JOIN roles r ON r.id=m.role WHERE m.uid=? ORDER BY r.name',uid),
      blocks:await all('SELECT u.id,u.handle FROM blocks b JOIN users u ON b.target=u.id WHERE b.owner=?',uid)});
    if(/^messages\/[\w-]+$/.test(action))return messages(action.slice(9),u);
    if(action==='reports'){requirePerm(u,'reports');return {reports:await all('SELECT * FROM reports ORDER BY time DESC LIMIT 100')};}
    if(action==='roles'){requirePerm(u,'manage');return {roles:await all('SELECT id,name FROM roles ORDER BY name')};}
    if(action==='moderation'){requirePerm(u,'timeout');return moderationList();}
    fail(404,'Chat endpoint not found.');
  }
  if(action==='logout'){await run('DELETE FROM sessions WHERE hash=?',key);disconnect(uid,key);endAccountVisits(uid,key);return {};}
  if(action==='profile')return profile(u,d);
  if(action==='rooms'){
    requirePerm(u,'manage');canSpeak(u);const name=clean(d.name,'channel name',32);
    if(!['text','voice'].includes(d.kind))fail(400,'Choose text or voice.');
    if((await one('SELECT count(*) AS n FROM rooms')).n>=100)fail(409,'Channel limit reached.');
    const id=randomUUID();
    if(!await run('INSERT OR IGNORE INTO rooms VALUES(?,?,?)',id,name,d.kind))fail(409,'That channel name is taken.');
    if(d.locked===true)await setChannelLock(id,u,true);
    if(d.staffOnly===true)await run('INSERT INTO staff_rooms(room) VALUES(?)',id);
    return {id};
  }
  if(action==='delete-message')return deleteMessage(u,d);
  if(action==='moderate-member'){requireAdmin(u);return moderateMember(u,d);}
  if(action==='channel-settings'){requirePerm(u,'manage');canSpeak(u);return channelSettings(u,d);}
  if(action==='room-lock' || action==='member-role' || action==='roles'){
    requirePerm(u,'manage');canSpeak(u);
    if(action==='room-lock')return setChannelLock(validString(d.room),u,d.locked);
    if(action==='member-role')return changeMemberRole(d);
    const name=clean(d.name,'role name',32),id=randomUUID();
    if(!await run('INSERT OR IGNORE INTO roles(id,name) VALUES(?,?)',id,name))fail(409,'That role name is already in use.');
    return {id,name};
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
    requirePerm(u,'reports');const r=await one('SELECT * FROM reports WHERE id=?',validString(d.report));
    if(!r)fail(404,'Report already resolved.');
    const actions={'mute':{action:'mute',minutes:1440},'mute-week':{action:'mute',minutes:10080},'kick':{action:'kick'},
      'ban-week':{action:'ban',days:7},'ban':{action:'ban'}};
    if(actions[d.decision]){
      await moderateMember(u,{target:r.target,...actions[d.decision]});
    }else if(d.decision==='remove'){
      requirePerm(u,'deleteAny');
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
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Goop-Visit');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(!['GET','POST'].includes(req.method))fail(405,'Method not allowed.');
    const action=pathname.slice('/api/chat/'.length);
    // A small simple POST can revoke a visit during cross-origin page teardown.
    if(action==='end-visit' && req.method==='POST'){
      if(req.headers['content-type']?.split(';')[0]!=='text/plain')fail(415,'Use plain text.');
      let size=0;const parts=[];
      for await(const part of req){size+=part.length;if(size>64)fail(413,'Invalid request.');parts.push(part);}
      closeVisit(Buffer.concat(parts).toString());
      return reply(200,{});
    }
    if(['signup','signin','recover'].includes(action)&&req.method==='POST')
      return reply(200,await auth(action,await body(req),req.socket.remoteAddress));
    if(!/^Bearer [0-9a-f]{64}$/.test(req.headers.authorization||''))fail(401,'Sign in to Goop Chat.');
    const key=sessionKey(req);
    if(action==='visit-connection' && req.method==='GET'){
      return connectVisit(key,req.headers['x-goop-visit'],res);
    }
    const data=req.method==='POST'?await body(req):null;
    const write=req.method==='POST' && !action.startsWith('voice/');
    const result=await withStore(write,async()=>{
      const current=await one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.uid WHERE s.hash=? AND s.expires>?',key,Date.now());
      if(!current)fail(401,'Sign in to Goop Chat.');
      const ban=await isBanned(current.id);if(ban)fail(403,banMessage(ban));
      // The legacy users.admin column never authorizes a request. Staff rank comes only from a live key visit.
      const level=hasVisit(key,req.headers['x-goop-visit']);
      return route(action,req.method,{...current,admin:level>0,staff:level},data,key);
    });
    return reply(200,result);
  }catch(e){
    if(!e.status)console.error('Chat storage or request failed:',e.code||e.name);
    if(!res.destroyed)reply(e.status||503,{error:e.status?e.message:'Chat storage is unavailable. Please try again.'});
  }
}
