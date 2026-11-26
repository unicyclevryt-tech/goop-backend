import { adminCode, digest, equal, fail, secret } from './chat-policy.mjs';

// A login continuation proves code entry. A separate page credential authorizes the visit.
const continuations = new Map();
const visits = new Map();
const validKey = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const idleMs = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key,expires] of continuations) if (expires <= now) continuations.delete(key);
  for (const [key,entry] of visits) if (entry.expires <= now) removeVisit(key);
}, 60000).unref();

export function beginCodeLogin(name) {
  if (adminCode.length < 24 || !equal(name,adminCode)) return null;
  if (continuations.size >= 2048) fail(429,'Please try signing in again shortly.');
  const step = secret();
  continuations.set(digest(step), Date.now() + 120000);
  return step;
}

export function useContinuation(step) {
  if (!validKey(step)) fail(401,'Sign-in expired. Start again.');
  const key = digest(step);
  const expires = continuations.get(key);
  continuations.delete(key);
  if (!expires || expires <= Date.now()) fail(401,'Sign-in expired. Start again.');
}

function removeVisit(key) {
  const visit = visits.get(key);
  if (!visit) return;
  visits.delete(key);
  if (visit.stream) visit.stream.end();
}

export function openVisit(token, uid) {
  const credential = secret();
  visits.set(digest(credential), {session: digest(token), uid, stream: null, expires: Date.now() + 30000});
  return credential;
}

// Only the document that finishes sign-in can hold this connection. Browser navigation
// cancels the stream, including when the document cannot deliver its pagehide beacon.
export function connectVisit(session, credential, res) {
  const key = validKey(credential) && digest(credential);
  const visit = visits.get(key);
  if (!visit || visit.session !== session || visit.stream || visit.expires <= Date.now()) {
    fail(403, 'Start a new sign-in.');
  }
  visit.stream = res;
  visit.expires = Date.now() + idleMs;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
  });
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
  heartbeat.unref();
  res.once('close', () => {
    clearInterval(heartbeat);
    visits.delete(key);
  });
  res.write(': connected\n\n');
}

export function hasVisit(session, credential) {
  if (!validKey(credential)) return false;
  const key = digest(credential), visit = visits.get(key);
  if (!visit || visit.session !== session || !visit.stream || visit.stream.destroyed) return false;
  if (visit.expires <= Date.now()) { removeVisit(key); return false; }
  visit.expires = Date.now() + idleMs;
  return true;
}

export function closeVisit(credential) {
  if (validKey(credential)) removeVisit(digest(credential));
}

export function endAccountVisits(uid, session) {
  for (const [key, visit] of visits) {
    if (visit.uid === uid && (!session || session === visit.session)) removeVisit(key);
  }
}

export function currentlyAdmin(uid) {
  for (const visit of visits.values()) {
    if (visit.uid === uid && visit.stream && !visit.stream.destroyed && visit.expires > Date.now()) return true;
  }
  return false;
}
