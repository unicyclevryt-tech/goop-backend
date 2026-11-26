import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { clean } from './chat-policy.mjs';

let database;
export function db() {
  if (database) return database;
  const legacy = path.resolve(process.env.CHAT_DATA_FILE || 'data/goop-chat.json');
  const filename = path.resolve(process.env.CHAT_DB_FILE || legacy+'.sqlite');
  mkdirSync(path.dirname(filename), {recursive:true, mode:0o700});
  const sql = new DatabaseSync(filename);
  try {
    chmodSync(filename,0o600);
    sql.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, handle TEXT UNIQUE COLLATE NOCASE, label TEXT NOT NULL, email TEXT, salt TEXT, hash TEXT, recovery TEXT, admin INTEGER DEFAULT 0, muted INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, uid TEXT REFERENCES users, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS session_users ON sessions(uid);
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dms(id TEXT PRIMARY KEY, a TEXT REFERENCES users, b TEXT REFERENCES users, UNIQUE(a,b));
      CREATE INDEX IF NOT EXISTS dm_inbox ON dms(b);
      CREATE TABLE IF NOT EXISTS msgs(id TEXT PRIMARY KEY, room TEXT NOT NULL, uid TEXT NOT NULL, label TEXT NOT NULL, text TEXT NOT NULL, time INTEGER NOT NULL, nonce TEXT NOT NULL, UNIQUE(room,uid,nonce));
      CREATE INDEX IF NOT EXISTS msg_room ON msgs(room,time);
      CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY, by_user TEXT, target TEXT, detail TEXT, message TEXT, time INTEGER, UNIQUE(by_user,target,message));
      CREATE TABLE IF NOT EXISTS blocks(owner TEXT REFERENCES users,target TEXT REFERENCES users,PRIMARY KEY(owner,target));
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY);
    `);
    if (!sql.prepare("SELECT 1 FROM meta WHERE key='initialized'").get()) {
      sql.exec('BEGIN IMMEDIATE');
      const add=sql.prepare('INSERT OR IGNORE INTO rooms VALUES(?,?,?)');
      for(const name of ['general','games','off-topic']) add.run(name,name,'text');
      add.run('voice-lounge','Lounge','voice');
      let previous={};
      try { previous=JSON.parse(readFileSync(legacy,'utf8')); } catch(e) { if(e.code!=='ENOENT') throw e; }
      const insert=sql.prepare('INSERT OR IGNORE INTO msgs VALUES(?,?,?,?,?,?,?)');
      for(const room of ['general','games','off-topic']){
        for(const m of (Array.isArray(previous[room])?previous[room]:[]).slice(-150)){
          let label, text;
          try { label=clean(m.nick,'name',24); text=clean(m.text,'message',1200); } catch {continue;}
          if(typeof m.id==='string' && Number.isSafeInteger(m.time)) insert.run(m.id,room,'legacy:'+m.id,label+' (guest)',text,m.time,m.id);
        }
      }
      sql.exec("INSERT INTO meta VALUES('initialized'); COMMIT;");
    }
    database=sql;
    return sql;
  } catch(e){ sql.close(); throw e; }
}
export function transaction(fn) {
  const sql=db(); sql.exec('BEGIN IMMEDIATE');
  try { const result=fn();sql.exec('COMMIT');return result; } catch(e){ sql.exec('ROLLBACK');throw e; }
}
