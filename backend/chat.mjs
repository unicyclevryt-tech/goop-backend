import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';

const legacyS3Origin = 'https://mathscholar.s3.us-east-2.amazonaws.com';
const currentS3Origins = new Set([
  'https://mathscholar.s3.amazonaws.com',
  'https://mathscholar.s3.us-east-1.amazonaws.com'
]);

const channels = ['general', 'games', 'off-topic'];
const file = path.resolve(process.env.CHAT_DATA_FILE || 'data/goop-chat.json');
const rooms = Object.fromEntries(channels.map(name => [name, []]));
try {
  const saved = JSON.parse(await readFile(file, 'utf8'));
  for (const name of channels) rooms[name] = saved[name].slice(-150);
} catch (err) { if (err.code !== 'ENOENT') throw err; }

// Serialize commits so simultaneous posts, retries and failed writes cannot lose messages.
let queue = Promise.resolve();
const windows = new Map();
const clock = setInterval(() => {
  for (const [key, item] of windows) if (item.until <= Date.now()) windows.delete(key);
}, 60000);
clock.unref();
function permit(key, limit) {
  let record = windows.get(key);
  if (!record || record.until <= Date.now()) {
    if (windows.size >= 20000 && !record) return false;
    record = {count: 0, until: Date.now() + 60000};
    windows.set(key, record);
  }
  return ++record.count <= limit;
}
function fail(code, message) { throw Object.assign(new Error(message), {status: code}); }
function publicMessage({nonce, ...item}) { return item; }
const forbidden = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3\ufe0f\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

export async function chat(req, res, pathname, origins) {
  const answer = (status, data) => {
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(data));
  };
  try {
    const origin = req.headers.origin;
    // Migrate Goop's old single-origin default for chat. Custom allowlists stay exact.
    const legacyAlias = origins.length === 1 && origins[0] === legacyS3Origin && currentS3Origins.has(origin);
    if (origin && !legacyAlias && !origins.includes(origin) && !origins.includes('*')) {
      let same = false;
      try { same = new URL(origin).host === req.headers.host && /^https?:\/\//.test(origin); } catch {}
      if (!same) fail(403, 'This site is not enabled for chat.');
    }
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary','Origin'); }
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
    const name = pathname.slice('/api/chat/'.length);
    if (!channels.includes(name)) fail(404,'Unknown channel.');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET') return answer(200,{messages: rooms[name].map(publicMessage)});
    if (req.method !== 'POST') fail(405,'Method not allowed.');
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail(415,'Use JSON.');
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
    if (!token) fail(401,'Missing guest identity.');
    if (!permit('ip:'+req.socket.remoteAddress, 180)) fail(429,'Too many messages. Try again in a minute.');
    const author = createHash('sha256').update(token).digest('hex').slice(0,12);
    let bytes = 0; const chunks = [];
    for await (const chunk of req) {
      if ((bytes += chunk.length) > 8192) fail(413,'Message is too large.');
      chunks.push(chunk);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400,'Invalid message.'); }
    const text = typeof data?.text === 'string' ? data.text.trim() : '';
    const nick = typeof data?.nick === 'string' ? data.nick.trim() : '';
    if (!text || text.length > 1200 || !nick || nick.length > 24 || nick.includes('\n') || forbidden.test(text+nick))
      fail(400,'Use a name up to 24 characters and a message up to 1,200 characters, without emoji.');
    if (!/^[a-f0-9-]{36}$/.test(data.nonce || '')) fail(400,'Invalid message ID.');
    const write = queue.then(async () => {
      const previous = rooms[name].find(m => m.author === author && m.nonce === data.nonce);
      if (previous) return previous;
      if (!permit('guest:'+author, 15)) fail(429,'You can send 15 messages per minute.');
      const item = {id:randomUUID(), author, nick, text, time:Date.now(), nonce:data.nonce};
      const next = [...rooms[name], item].slice(-150);
      await mkdir(path.dirname(file),{recursive:true});
      await writeFile(file+'.tmp', JSON.stringify({...rooms,[name]:next}),{mode:0o600});
      await rename(file+'.tmp',file);
      rooms[name] = next;
      return item;
    });
    queue = write.catch(() => {});
    return answer(200,{message:publicMessage(await write)});
  } catch (err) {
    if (!res.destroyed) answer(err.status || 503,{error:err.status ? err.message : 'Chat storage is unavailable. Try again.'});
  }
}
