import { createHmac, randomUUID } from 'node:crypto';
import { db } from './chat-store.mjs';
import { fail, rate } from './chat-policy.mjs';

const seats=new Map();
function prune() {
  for(const [id,s] of seats) if (s.seen < Date.now()-90000) seats.delete(id);
}
setInterval(prune,15000).unref();
export function disconnect(uid, session) {
  for (const [id,s] of seats) if(s.uid===uid && (!session || s.session===session)) seats.delete(id);
}
function ice(uid) {
  const stun=(process.env.GOOP_STUN_URL || 'stun:stun.l.google.com:19302');
  const servers=[{urls:stun}];
  const urls=(process.env.GOOP_TURN_URLS || '').split(',').map(x=>x.trim()).filter(x=>/^turns?:[^\s]+$/.test(x));
  if (urls.length && process.env.GOOP_TURN_SECRET) {
    const username=Math.floor(Date.now()/1000+3600)+':'+uid;
    servers.push({urls,username,credential:createHmac('sha1',process.env.GOOP_TURN_SECRET).update(username).digest('base64')});
  }
  return servers;
}
export function blocked(a,b){
  return !!db().prepare('SELECT 1 FROM blocks WHERE (owner=? AND target=?) OR (owner=? AND target=?)').get(a,b,b,a);
}
export function voice(action,user,session,data) {
  prune();
  if (action==='join') {
    if (user.muted>Date.now()) fail(403,'Your account is muted.');
    if (!db().prepare("SELECT id FROM rooms WHERE id=? AND kind='voice'").get(data.room)) fail(404,'Voice channel not found.');
    rate('join:'+user.id,20);
    const others=[...seats.values()].filter(s=>s.room===data.room && s.uid!==user.id);
    if(others.length>=6) fail(409,'This voice channel is full.');
    disconnect(user.id);
    const ticket=randomUUID();
    seats.set(ticket,{ticket,uid:user.id,session,label:user.label,room:data.room,seen:Date.now(),signals:[],seq:0});
    return {ticket,iceServers:ice(user.id)};
  }
  const seat=seats.get(data.ticket);
  if (!seat || seat.uid!==user.id || seat.session!==session) fail(410,'Voice session ended. Join again to reconnect.');
  if (action==='leave'){seats.delete(seat.ticket);return {};}
  if (user.muted>Date.now()) {disconnect(user.id);fail(403,'Your account is muted.');}
  seat.seen=Date.now();
  if(action==='poll'){
    const after=Number(data.after)||0;
    seat.signals=seat.signals.filter(s=>s.seq>after && seats.has(s.from) && !blocked(user.id,seats.get(s.from).uid));
    return {peers:[...seats.values()].filter(s=>s.room===seat.room && s!==seat && !blocked(s.uid,user.id))
      .map(s=>({id:s.uid,label:s.label,ticket:s.ticket})),signals:seat.signals};
  }
  if(action!=='signal') fail(404,'Unknown voice action.');
  rate('signal:'+user.id,450);
  const peer=seats.get(data.to);
  if (!peer || peer.room!==seat.room || peer===seat || blocked(peer.uid,user.id)) fail(410,'Peer has left.');
  const input=data.signal;
  let signal;
  if (input?.type==='candidate' && typeof input.candidate==='string' && input.candidate.length<=2048)
    signal={type:'candidate',candidate:input.candidate,sdpMid:typeof input.sdpMid==='string'?input.sdpMid.slice(0,64):null,sdpMLineIndex:Number.isInteger(input.sdpMLineIndex)?input.sdpMLineIndex:0};
  else if (['offer','answer'].includes(input?.type) && typeof input.sdp==='string' && input.sdp.length<=20000 && /^m=audio /m.test(input.sdp) && !/^m=(?!audio )/m.test(input.sdp))
    signal={type:input.type,sdp:input.sdp};
  else fail(400,'Invalid audio signal.');
  if(peer.signals.length>=160) fail(429,'Peer is busy. Rejoin voice.');
  peer.signals.push({from:seat.ticket,seq:++peer.seq,signal});
  return {};
}
