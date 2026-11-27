import { randomUUID, createHash } from 'node:crypto';
import { one, all, run } from './chat-store.mjs';
import { clean, fail, rate } from './chat-policy.mjs';

const sources = new Set(['offline','ugs','seraph','truffled','ckv','fourgames','multiplayer']);
function text(value,limit) {
  if(typeof value!=='string'||!value.trim()||value.length>limit||/[\x00-\x1f\x7f]/.test(value)) fail(400,'Invalid player item.');
  return value.trim();
}
function game(value) {
  if(!value || !sources.has(value.source)) fail(400,'Choose a Goop game.');
  return {source:value.source,name:text(value.name,160)};
}
export function invitation(value) {
  const g=game(value);clean(g.name,'message',160);
  if (!value.roomUrl)return g;
  let u;try{u=new URL(value.roomUrl);}catch{fail(400,'Invalid game room link.');}
  const valid=g.source==='multiplayer' && u.protocol==='https:' && !u.username && !u.password && !u.port && !u.hash &&
    ((g.name==='skribbl.io' && u.hostname==='skribbl.io' && u.pathname==='/' && /^\?[A-Za-z0-9_-]{2,100}$/.test(u.search)) ||
     (g.name==='Gartic Phone' && u.hostname==='garticphone.com' && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/?)?$/i.test(u.pathname) && /^\?c=[A-Za-z0-9_-]{2,100}$/.test(u.search)));
  if(!valid) fail(400,'Use the room invitation from this game.');
  return {...g,roomUrl:u.href};
}
function item(raw) {
  if(raw?.kind==='favorite')return {kind:'favorite',...game(raw)};
  if(raw?.kind!=='bookmark')fail(400,'Unknown saved item.');
  let url;try{url=new URL(text(raw.url,2048));}catch{fail(400,'Invalid bookmark URL.');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)fail(400,'Use a web bookmark without credentials.');
  return {kind:'bookmark',url:url.href,name:text(raw.name,160)};
}
export async function playerRoute(action,method,u,data) {
  if(action==='player-items'){
    if(method==='GET')return {items:(await all('SELECT item FROM player_items WHERE uid=? ORDER BY rowid',u.id)).map(row=>JSON.parse(row.item))};
    if(!Array.isArray(data.changes)||data.changes.length>20)fail(400,'Invalid changes.');
    for(const change of data.changes){
      const v=item(change?.item),key=createHash('sha256').update(JSON.stringify([v.kind,v.kind==='bookmark'?v.url:v.source,v.kind==='bookmark'?'':v.name])).digest('hex');
      if(change.op==='remove')await run('DELETE FROM player_items WHERE uid=? AND key=?',u.id,key);
      else if(change.op==='put')await run('INSERT INTO player_items(uid,key,item) VALUES(?,?,?) ON CONFLICT(uid,key) DO UPDATE SET item=excluded.item',u.id,key,JSON.stringify(v));
      else fail(400,'Invalid change.');
    }
    if((await one('SELECT count(*) AS n FROM player_items WHERE uid=?',u.id)).n>600)fail(409,'Your account can sync up to 600 items.');
    return {};
  }
  if(action==='game-report' && method==='POST'){
    rate('game-report:'+u.id,12,600000);
    const g=game(data.game),detail=text(data.detail,500);
    await run('INSERT INTO game_reports VALUES(?,?,?,?,?,?) ON CONFLICT(uid,source,title) DO UPDATE SET detail=excluded.detail,created=excluded.created',randomUUID(),u.id,g.source,g.name,detail,Date.now());
    return {};
  }
  if(action==='game-reports'){
    if(!u.admin)fail(403,'Admin access is required.');
    if(method==='GET')return {reports:await all('SELECT id,source,title,detail,created FROM game_reports ORDER BY created DESC LIMIT 100')};
    await run('DELETE FROM game_reports WHERE id=?',text(data.id,64));return {};
  }
  fail(404,'Unknown player action.');
}
