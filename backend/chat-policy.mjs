import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
export const secret = () => randomBytes(32).toString('hex');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const equal = (a, b) => timingSafeEqual(Buffer.from(digest(a),'hex'), Buffer.from(digest(b),'hex'));

const derive = promisify(scrypt);
let hashing = 0;
export async function hashPassword(password, salt) {
  if (hashing >= 2) fail(429, 'Sign-in is busy. Try again in a moment.');
  hashing++;
  try {
    return (await derive(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 ** 2 })).toString('hex');
  } finally { hashing--; }
}
export function newPassword(value) {
  if (typeof value !== 'string' || value.length < 15 || value.length > 128)
    fail(400, 'Use a password or passphrase between 15 and 128 characters.');
  return value;
}
export const adminCode = process.env.GOOP_CHAT_ADMIN_CODE || '';
// Staff keys, lowest to highest rank. GOOP_CHAT_ADMIN_CODE is the owner key and can do everything.
export const staffRanks = ['','trial mod','moderator','admin','co-owner','owner'];
export const staffCodes = [
  [1, process.env.GOOP_CHAT_TRIAL_MOD_CODE],
  [2, process.env.GOOP_CHAT_MOD_CODE],
  [3, process.env.GOOP_CHAT_STAFF_ADMIN_CODE],
  [4, process.env.GOOP_CHAT_CO_OWNER_CODE],
  [5, adminCode],
].map(([level,code])=>[level,(code||'').trim()]).filter(([,code])=>code.length>=24);
// What each rank may do. Ranks inherit everything below them.
export function permissions(level){
  return {
    modChannels: level>=1, timeout: level>=1, reports: level>=1,
    kick: level>=2,
    tempBan: level>=3,
    permBan: level>=4, manage: level>=4,
    deleteAny: level>=5,
  };
}
const extra = (process.env.GOOP_CHAT_BLOCKED_WORDS || '').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
// Common misspellings and shorthand that a plain word list misses. Spellings that only
// swap letters for sound-alikes (ph→f, c/ck/q→k) are caught by sound() below instead.
const variants = ['fk','fks','fking','fkin','fkn','fker','fkr','fked','fkd','fku','fkoff','fuk','fuking','fukin','fukn','fuker','fukr','fuks','fukd','fuked','fukoff','fukyou','fuku',
  'mf','mfs','mfer','mfers','mofo','mofos','motherfuker','muthafuka','muthafucka','mothafucka','mtherfker',
  'sht','shyt','shiet','shite','shiit','shitt','bs','bullsht','horseshit','dipshit','shithead','shitface','shitass',
  'btch','bytch','biatch','biotch','beotch','bich','bish','bitchass','sonofabitch',
  'azz','arse','arsehole','asshat','asswipe','dumbass','jackass','smartass','fatass','dumass','dumbazz',
  'dik','dikhead','dck','dickface','dickwad','cok','cocksucker','twat','wanker','prick','bellend','tits','titties','boobs','cum','jizz','horny','sexy','sex',
  'kunt','cnt','whor','hoe','hoes','thot','slvt','skank',
  'niga','nigah','nigguh','niggah','nibba','nibber','fagot','faggit','fagget','fgt','tard','retarded','ret4rd',
  'gtfo','stfu','kms','kysnow','dumbfuck','fuckboy','fuckface','fuckoff','fuckyou','fucku'];
const blocked = [...variants,'ass','dick','pussy','bastards','bitching','fucked','fucks','fck','stfu','stf u','wtf','shits','piss','douchebag','fuck','fucker','fucking','motherfucker','shit','bullshit','shitty','bitch','bitches','asshole','bastard','dickhead','cunt','whore','slut','nigger','nigga','faggot','fag','retard','kike','chink','spic','tranny','porn','pornhub','nudes','kys',...extra];
const phrases = ['kill yourself','go kill yourself','send nudes','i will kill you','i am going to kill you','go die', ...extra.filter(s=>s.includes(' '))];
const controls = /[\p{Cf}\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3\ufe0f\u0000-\u0008\u000b-\u001f\u007f]/u;
const swaps = {'0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','8':'b','@':'a','$':'s','!':'i','а':'a','е':'e','о':'o','р':'p','с':'c','х':'x','і':'i','ѕ':'s','у':'y'};
const fold = s => s.normalize('NFKD').toLowerCase().replace(/\p{M}/gu,'').replace(/[0134578@$!аеорсхіѕу]/gu, c=>swaps[c]);
const squeeze = s => s.replace(/(.)\1+/g,'$1');
// Spell words the way they sound, so "phuck", "fuq", "fucc" and "kunt" match their dictionary words.
const sound = s => s.replace(/ph/g,'f').replace(/ck/g,'k').replace(/[cq]/g,'k').replace(/x/g,'ks');
// Word roots that are blocked inside longer words too ("fukkin", "shitposting", "bitchy").
// Checked against single words only, never across word boundaries.
const roots = ['fuk','shit','bitkh','kunt','niga','nigu','fagot','faget','fagit','retard','whore','slut','pusy','motherf','koksuk']
  .map(r=>new RegExp(r));
// Ordinary words that happen to contain a root above.
const safeWords = new Set(['fukushima','fuchsia','fuchsias','scunthorpe','shiitake','shitake','retardant','retardants','retardation']);
const alphanumeric = value => fold(value).replace(/[^a-z0-9]/g,'');
function repeatedPattern(term) {
  return Array.from(term.matchAll(/(.)\1*/g), m => m[1]+'{'+m[0].length+',}').join('');
}
const dictionary = new Map();
for (const term of [...new Set(blocked.map(alphanumeric).filter(Boolean).flatMap(t=>[t,sound(t)]))]) {
  const key=squeeze(term), tests=dictionary.get(key)||[];
  tests.push(new RegExp('^'+repeatedPattern(term)+'$'));dictionary.set(key,tests);
}
const badNameParts = ['fuck','bitch','nigg','fagg','asshole','porn','cunt',...extra]
  .map(alphanumeric).filter(Boolean).map(term=>new RegExp(repeatedPattern(term)));
export function clean(value, kind, limit) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s || s.length > limit || controls.test(s)) fail(400,'Use plain text within the character limit.');
  const folded = fold(s);
  const tokens = folded.match(/[a-z0-9]+/g) || [];
  // Check complete words and joined token runs (including spaced or punctuated spellings).
  const matches = words => words.some((_, i) => {
    let joined = '';
    for (let j=i; j<words.length && j<i+16 && joined.length<64; j++) {
      joined += words[j];
      if (dictionary.get(squeeze(joined))?.some(pattern=>pattern.test(joined))) return true;
    }
    return false;
  });
  const compact = squeeze(tokens.join(''));
  const sounds = tokens.map(sound);
  if (staffCodes.some(([,code])=>s.includes(code)) || matches(tokens) || matches(sounds) || matches(s.toLowerCase().match(/[a-z]+/g)||[]) ||
      sounds.some((w,i)=>!safeWords.has(tokens[i]) && roots.some(r=>r.test(squeeze(w)))) ||
      phrases.some(p=>compact.includes(squeeze(fold(p).replace(/[^a-z0-9]/g,'')))) ||
      (kind!=='message' && badNameParts.some(p=>p.test(tokens.join(''))))) fail(400,'Please choose different wording. The chat filter blocked this '+kind+'.');
  if (kind !== 'message' && !/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(s))
    fail(400,'Use letters, numbers, spaces, dashes or underscores in the name.');
  if (kind === 'name' && /^(admin(istrator)?|moderator|gopstaf|system|gopai)$/i.test(compact))
    fail(400,'That name is reserved.');
  return s;
}
export function handle(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,23}$/.test(value)) fail(400,'Use a username of 3–24 letters, numbers, dashes or underscores.');
  return clean(value,'name',24);
}
const rates = new Map();
setInterval(() => { for (const [k,r] of rates) if (r.until<=Date.now()) rates.delete(k); },60000).unref();
export function rate(key, count, windowMs=60000) {
  let r=rates.get(key);
  if (!r || r.until<=Date.now()) {
    if (!r && rates.size>=30000) fail(429,'The chat server is busy. Try again shortly.');
    r={used:0,until:Date.now()+windowMs};rates.set(key,r);
  }
  if (++r.used>count) fail(429,'Too many attempts. Try again later.');
}
