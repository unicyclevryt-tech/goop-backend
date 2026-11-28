import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { clean, fail } from './chat-policy.mjs';

const schema = `
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, handle TEXT UNIQUE COLLATE NOCASE, label TEXT NOT NULL, email TEXT, salt TEXT, hash TEXT, recovery TEXT, admin INTEGER DEFAULT 0, muted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, uid TEXT REFERENCES users, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS session_users ON sessions(uid);
CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, kind TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS channel_locks(room TEXT PRIMARY KEY REFERENCES rooms(id), owner TEXT NOT NULL REFERENCES users(id));
CREATE TABLE IF NOT EXISTS roles(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS member_roles(uid TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL REFERENCES roles(id), PRIMARY KEY(uid,role));
CREATE TABLE IF NOT EXISTS dms(id TEXT PRIMARY KEY, a TEXT REFERENCES users, b TEXT REFERENCES users, UNIQUE(a,b));
CREATE INDEX IF NOT EXISTS dm_inbox ON dms(b);
CREATE TABLE IF NOT EXISTS msgs(id TEXT PRIMARY KEY, room TEXT NOT NULL, uid TEXT NOT NULL, label TEXT NOT NULL, text TEXT NOT NULL, time INTEGER NOT NULL, nonce TEXT NOT NULL, UNIQUE(room,uid,nonce));
CREATE INDEX IF NOT EXISTS msg_room ON msgs(room,time);
CREATE TABLE IF NOT EXISTS discord_links(goop_id TEXT PRIMARY KEY REFERENCES msgs(id) ON DELETE CASCADE, channel TEXT NOT NULL, discord_id TEXT, reply_to TEXT, UNIQUE(channel,discord_id));
CREATE INDEX IF NOT EXISTS discord_pending ON discord_links(channel,goop_id) WHERE discord_id IS NULL;
CREATE TABLE IF NOT EXISTS discord_cursors(channel TEXT NOT NULL, room TEXT NOT NULL, last_id TEXT NOT NULL, PRIMARY KEY(channel,room));
CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY, by_user TEXT, target TEXT, detail TEXT, message TEXT, time INTEGER, UNIQUE(by_user,target,message));
CREATE TABLE IF NOT EXISTS blocks(owner TEXT REFERENCES users,target TEXT REFERENCES users,PRIMARY KEY(owner,target));
CREATE TABLE IF NOT EXISTS player_items(uid TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, item TEXT NOT NULL, PRIMARY KEY(uid,key));
CREATE TABLE IF NOT EXISTS game_reports(id TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES users(id), source TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(uid,source,title));
CREATE TABLE IF NOT EXISTS game_invites(message_id TEXT PRIMARY KEY REFERENCES msgs(id) ON DELETE CASCADE, invite TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS bans(uid TEXT PRIMARY KEY, by_user TEXT, time INTEGER NOT NULL, until INTEGER);
CREATE TABLE IF NOT EXISTS staff_rooms(room TEXT PRIMARY KEY REFERENCES rooms(id));
CREATE TABLE IF NOT EXISTS channel_post_roles(room TEXT NOT NULL REFERENCES rooms(id), role TEXT NOT NULL REFERENCES roles(id), PRIMARY KEY(room,role));
UPDATE users SET admin=0 WHERE admin<>0;
`;
const rooms = [['general','general','text'],['games','games','text'],['off-topic','off-topic','text'],['voice-lounge','Lounge','voice']];
const context = new AsyncLocalStorage();
let ready, localQueue = Promise.resolve();

function localTransaction(database, write, work) {
  const execute = async () => {
    database.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = await work();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };
  const next = localQueue.then(execute);
  localQueue = next.catch(() => {});
  return next;
}

function openLocal() {
  const legacy = path.resolve(process.env.CHAT_DATA_FILE || 'data/goop-chat.json');
  const filename = path.resolve(process.env.CHAT_DB_FILE || legacy+'.sqlite');
  if (process.env.RENDER === 'true') {
    // Render Docker disks appear as a separate mount. Avoid accepting accounts on its temporary root.
    const mounts = readFileSync('/proc/self/mountinfo','utf8').split('\n').map(line=>line.split(' ')[4]);
    const durable = mounts.some(mount => mount && mount!=='/' && filename.startsWith(mount+'/'));
    if (!durable) fail(503,'Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN on the Goop gateway to enable durable chat storage.');
  }
  mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
  const sql=new DatabaseSync(filename);
  try {
    chmodSync(filename,0o600);
    sql.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    sql.exec(schema);
    if(!sql.prepare("SELECT 1 FROM meta WHERE key='initialized'").get()){
      sql.exec('BEGIN IMMEDIATE');
      const add=sql.prepare('INSERT OR IGNORE INTO rooms VALUES(?,?,?)');
      for(const room of rooms)add.run(...room);
      let previous={};
      try { previous=JSON.parse(readFileSync(legacy,'utf8')); } catch(e) { if(e.code!=='ENOENT')throw e; }
      const insert=sql.prepare('INSERT OR IGNORE INTO msgs VALUES(?,?,?,?,?,?,?)');
      for(const [room,,kind] of rooms){
        if(kind!=='text')continue;
        for(const m of (Array.isArray(previous[room])?previous[room]:[]).slice(-150)){
          let label,text;
          try{label=clean(m.nick,'name',24);text=clean(m.text,'message',1200);}catch{continue;}
          if(typeof m.id==='string' && Number.isSafeInteger(m.time))insert.run(m.id,room,'legacy:'+m.id,label+' (guest)',text,m.time,m.id);
        }
      }
      sql.exec("INSERT INTO meta VALUES('initialized'); COMMIT;");
    }
    const queries={
      one:(q,args)=>sql.prepare(q).get(...args),
      all:(q,args)=>sql.prepare(q).all(...args),
      run:(q,args)=>sql.prepare(q).run(...args).changes
    };
    return {scope:(write,work)=>localTransaction(sql,write,()=>context.run(queries,work))};
  } catch(error){sql.close();throw error;}
}

async function openStore(){
  const url=process.env.TURSO_DATABASE_URL?.trim(),authToken=process.env.TURSO_AUTH_TOKEN?.trim();
  if(!url && !authToken)return openLocal();
  if(!url || !authToken)fail(503,'Set both Turso environment variables on the Goop gateway.');
  const address=new URL(url);
  const local=['localhost','127.0.0.1','[::1]'].includes(address.hostname);
  if(!['libsql:','https:'].includes(address.protocol) && !(local && address.protocol==='http:'))
    fail(503,'Use the secure database URL from Turso.');
  if(address.username || address.password || address.search || address.hash)fail(503,'Use the database URL without embedded credentials or query parameters.');
  if(address.protocol==='libsql:')address.href='https://'+address.host+address.pathname;
  const {createClient}=await import('@libsql/client/http');
  const client=createClient({url:address.href,authToken});
  try{
    // One round trip and one transaction, including on a brand-new hosted database.
    await client.batch([...schema.split(';').filter(q=>q.trim()),
      ...rooms.map(args=>({sql:'INSERT OR IGNORE INTO rooms VALUES(?,?,?)',args})),
      "INSERT OR IGNORE INTO meta VALUES('initialized')"], 'write');
  }catch(error){client.close();throw error;}
  return {async scope(write,work){
    const tx=await client.transaction(write?'write':'read');
    const query=(sql,args)=>tx.execute({sql,args});
    const queries={
      one:async(q,args)=>(await query(q,args)).rows[0],
      all:async(q,args)=>(await query(q,args)).rows,
      run:async(q,args)=>(await query(q,args)).rowsAffected
    };
    try{
      const value=await context.run(queries,work);
      await tx.commit();
      return value;
    }catch(error){
      if(!tx.closed)await tx.rollback().catch(()=>{});
      throw error;
    }finally{tx.close();}
  }};
}

export async function withStore(write,work){
  ready ??= openStore().catch(error=>{ready=undefined;throw error;});
  return (await ready).scope(write,work);
}
export const one=(q,...args)=>context.getStore().one(q,args);
export const all=(q,...args)=>context.getStore().all(q,args);
export const run=(q,...args)=>context.getStore().run(q,args);

export const trimMessages = room => run(
  'DELETE FROM msgs WHERE room=? AND rowid NOT IN(SELECT rowid FROM msgs WHERE room=? ORDER BY time DESC,rowid DESC LIMIT 150)', room,room
);
