// backend/plays.mjs
// Public play counter and trending list for the Goop home page.
//
//   POST /api/plays/hit        body {"source":"ugs","name":"Game name"}  -> 204
//   GET  /api/plays/trending   -> {"days":7,"games":[{"source","name","plays"}]}
//
// The browser sends hits as text/plain so it can use sendBeacon without a CORS preflight.
// Only counters are stored: game, day, count. No account or visitor details.
import { withStore, one, all, run } from './chat-store.mjs';
import { fail, rate } from './chat-policy.mjs';

const SOURCES = new Set(['offline', 'ugs', 'seraph', 'truffled', 'ckv', 'fourgames', 'multiplayer']);
const DAY = 86400000;
const WINDOW_DAYS = 7;     // what "trending" covers
const KEEP_DAYS = 30;      // older counters are deleted
const MAX_ROWS = 20000;    // stops junk names from growing the table forever
const TOP = 12;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;

let ready = null;
let cache = { at: 0, body: null };
let lastPrune = 0;

const today = () => Math.floor(Date.now() / DAY);

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// Render puts a proxy in front of the app, so prefer the forwarded address.
// A visitor can fake this header, which at worst lets them inflate a counter.
function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

async function readJson(req) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && type !== 'text/plain') fail(415, 'Use JSON.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024) fail(413, 'Request too large.');
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Use JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'Use a JSON object.');
  return data;
}

function validGame(data) {
  const source = data.source;
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!SOURCES.has(source) || !name || name.length > 160 || CONTROLS.test(name)) fail(400, 'Not a valid game.');
  return { source, name };
}

// Creates the table the first time it is needed. Safe to run on every start.
function ensure() {
  ready ||= withStore(true, async () => {
    await run('CREATE TABLE IF NOT EXISTS game_plays(source TEXT NOT NULL, name TEXT NOT NULL, day INTEGER NOT NULL, plays INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(source,name,day))');
    await run('CREATE INDEX IF NOT EXISTS game_plays_day ON game_plays(day)');
  }).catch(e => { ready = null; throw e; });
  return ready;
}

async function hit(req, res) {
  rate('plays-ip:' + clientIp(req), 60, 600000);
  const game = validGame(await readJson(req));
  await ensure();
  await withStore(true, async () => {
    const day = today();
    const seen = await one('SELECT 1 AS ok FROM game_plays WHERE source=? AND name=? LIMIT 1', game.source, game.name);
    if (!seen) {
      const total = await one('SELECT COUNT(*) AS n FROM game_plays');
      if (Number(total?.n) >= MAX_ROWS) return;
    }
    await run(
      'INSERT INTO game_plays(source,name,day,plays) VALUES(?,?,?,1) ON CONFLICT(source,name,day) DO UPDATE SET plays=plays+1',
      game.source, game.name, day
    );
    if (Date.now() - lastPrune > 3600000) {
      lastPrune = Date.now();
      await run('DELETE FROM game_plays WHERE day<?', day - KEEP_DAYS);
    }
  });
  res.writeHead(204);
  res.end();
}

async function trending(res) {
  if (cache.body && Date.now() - cache.at < 60000) return send(res, 200, cache.body);
  await ensure();
  let rows = [];
  await withStore(false, async () => {
    rows = await all(
      'SELECT source,name,SUM(plays) AS plays FROM game_plays WHERE day>=? GROUP BY source,name ORDER BY plays DESC, name LIMIT ?',
      today() - (WINDOW_DAYS - 1), TOP
    );
  });
  const body = { days: WINDOW_DAYS, games: rows.map(r => ({ source: r.source, name: r.name, plays: Number(r.plays) })) };
  if (body.games.length) cache = { at: Date.now(), body }; // empty lists are not cached, so the first plays show up straight away
  send(res, 200, body);
}

export async function plays(req, res, pathname) {
  try {
    const action = pathname.slice('/api/plays/'.length);
    if (action === 'trending') {
      if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method not allowed.');
      return await trending(res);
    }
    if (action === 'hit') {
      if (req.method !== 'POST') fail(405, 'Method not allowed.');
      return await hit(req, res);
    }
    fail(404, 'Not found.');
  } catch (e) {
    if (e?.status) return send(res, e.status, { error: e.message });
    console.error('plays route failed:', e?.message || e);
    send(res, 503, { error: 'Play counts are unavailable right now.' });
  }
}
