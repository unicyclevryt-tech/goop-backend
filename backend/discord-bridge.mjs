import {createHash} from 'node:crypto';
import {clean} from './chat-policy.mjs';
import {all, one, run, trimMessages, withStore} from './chat-store.mjs';

const snowflake = value => typeof value === 'string' && /^[1-9]\d{16,19}$/.test(value);
const epoch = 1420070400000n;
const pause = 8000;
const dedicatedRoom = 'discord';

export function bridgeConfig() {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  const channel = process.env.DISCORD_CHANNEL_ID?.trim();
  const room = process.env.GOOP_CHAT_ROOM_ID?.trim() || 'general';
  if (token && snowflake(channel) && /^[\w-]{1,64}$/.test(room)) return {token, channel, room};
}

// Called in the transaction that accepts a local text message.
export async function queueDiscordMessage(room, id) {
  const config = bridgeConfig();
  if (config?.room === room) await run('INSERT INTO discord_links(goop_id,channel) VALUES(?,?)',id,config.channel);
}

function senderLabel(author) {
  for (const name of [author.global_name, author.username]) {
    try { return clean(name,'name',24)+' (Discord)'; } catch (error) { if (error.status !== 400) throw error; }
  }
  return 'Member (Discord)';
}

async function importText(config, msg) {
  if (msg.channel_id !== config.channel || ![0,19].includes(msg.type) || msg.author?.bot ||
      msg.webhook_id || msg.message_reference?.type === 1 || !snowflake(msg.author?.id) || !msg.content) return;
  let text;
  try { text=clean(msg.content,'message',1200); } catch (error) { if (error.status === 400) return; throw error; }
  const room=await one(`SELECT r.kind,l.owner FROM rooms r LEFT JOIN channel_locks l ON l.room=r.id WHERE r.id=?`,config.room);
  if (room?.kind !== 'text' || room.owner) return;
  const uid='discord:'+msg.author.id, label=senderLabel(msg.author);
  const user=await one('SELECT muted FROM users WHERE id=?',uid);
  if (user?.muted > Date.now()) return;
  const time=Number((BigInt(msg.id)>>22n)+epoch);
  // Use message time so a burst of history after a restart follows the same per-minute limit.
  const recent=await one('SELECT count(*) AS n FROM msgs WHERE uid=? AND room=? AND time BETWEEN ? AND ?',uid,config.room,time-60000,time);
  if (recent.n>=20) return;
  // A NULL handle leaves the external identity unavailable to Goop login and DM lookup.
  if (!user) await run('INSERT INTO users(id,label) VALUES(?,?)',uid,label);
  const id='discord:'+msg.id;
  if (!await run('INSERT OR IGNORE INTO msgs VALUES(?,?,?,?,?,?,?)',id,config.room,uid,label,text,time,msg.id)) return;
  const ref=msg.message_reference;
  const reply=msg.type===19 && (!ref?.channel_id || ref.channel_id===config.channel) && snowflake(ref?.message_id) ? ref.message_id : null;
  await run('INSERT INTO discord_links(goop_id,channel,discord_id,reply_to) VALUES(?,?,?,?)',id,config.channel,msg.id,reply);
  await trimMessages(config.room);
}

function markdownName(name) { return name.replace(/([\\*_~`|])/g,'\\$1'); }

export function discordRelay(config, request=fetch) {
  const {channel,room,token}=config;
  const startedAt=String((BigInt(Date.now())-epoch)<<22n);
  let initialized;
  async function api(path, body) {
    const response=await request('https://discord.com/api/v10/channels/'+channel+path,{
      method:body?'POST':'GET', redirect:'error', signal:AbortSignal.timeout(12000),
      headers:{Authorization:'Bot '+token,'Content-Type':'application/json'},
      ...(body ? {body:JSON.stringify(body)} : {})
    });
    if (!response.ok) {
      const detail=await response.json().catch(()=>({}));
      const error=Object.assign(new Error('Discord HTTP '+response.status),{status:response.status,code:detail.code});
      if (response.status===429) {
        error.retryMs=Math.ceil(1000*(Number(detail.retry_after)||Number(response.headers.get('retry-after'))||5));
      }
      throw error;
    }
    return response.json();
  }
  async function initialize() {
    const target=await api('');
    if(target.id!==channel || target.type!==0 || !snowflake(target.guild_id)) throw Error('Select a Discord server text channel.');
    await withStore(true,async()=>{
      const existing = await one('SELECT kind FROM rooms WHERE id=?',room);
      if (!existing && room === dedicatedRoom) {
        // Keep any pre-existing user-created channel with this name separate.
        const names = new Set((await all('SELECT lower(name) AS name FROM rooms')).map(r=>r.name));
        let name = dedicatedRoom;
        for (let n=1; names.has(name); n++) {
          name = n === 1 ? 'discord-bridge' : 'discord-bridge-'+n;
        }
        await run('INSERT INTO rooms(id,name,kind) VALUES(?,?,?)',room,name,'text');
      } else if (existing?.kind !== 'text') {
        throw Error('Select an existing Goop text room.');
      }
      await run('INSERT OR IGNORE INTO discord_cursors(channel,room,last_id) VALUES(?,?,?)',channel,room,startedAt);
    });
  }
  function ready() {
    return initialized ??= initialize().catch(error=>{ initialized=undefined; throw error; });
  }
  async function pull() {
    await ready();
    const cursor=()=>one('SELECT last_id FROM discord_cursors WHERE channel=? AND room=?',channel,room);
    const {last_id}=await withStore(false,cursor);
    const batch=await api('/messages?limit=50&after='+last_id);
    if (!Array.isArray(batch)) throw Error('Invalid Discord message list.');
    const messages=batch.filter(m=>snowflake(m?.id) && BigInt(m.id)>BigInt(last_id))
      .sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
    for(const message of messages) {
      // Store each message and its cursor together, including intentionally skipped messages.
      await withStore(true,async()=>{
        if(BigInt((await cursor()).last_id)>=BigInt(message.id)) return;
        await importText(config,message);
        await run('UPDATE discord_cursors SET last_id=? WHERE channel=? AND room=?',message.id,channel,room);
      });
    }
    return messages.length===50;
  }
  async function push() {
    await ready();
    const pending=await withStore(false,()=>all(`SELECT m.id,m.label,m.text FROM discord_links l JOIN msgs m ON m.id=l.goop_id
      JOIN rooms r ON r.id=m.room AND r.kind='text' WHERE l.channel=? AND m.room=? AND l.discord_id IS NULL
      ORDER BY m.time,m.rowid LIMIT 10`,channel,room));
    for(const msg of pending) {
      const body={
        content:'**'+markdownName(msg.label)+':** '+msg.text,
        allowed_mentions:{parse:[],replied_user:false},
        flags:4, // Suppress automatic link embeds.
        nonce:createHash('sha256').update(channel+'/'+msg.id).digest('hex').slice(0,24),enforce_nonce:true
      };
      let sent;
      try { sent=await api('/messages',body); }
      catch(error) {
        if (![200000,240000].includes(error.code)) throw error;
        // Honor Discord's moderation decision and continue sending other accepted messages.
        await withStore(true,()=>run('DELETE FROM discord_links WHERE goop_id=? AND channel=? AND discord_id IS NULL',msg.id,channel));
        continue;
      }
      if (!snowflake(sent.id) || sent.channel_id !== channel) throw Error('Invalid Discord send acknowledgement.');
      await withStore(true,()=>run('UPDATE discord_links SET discord_id=? WHERE goop_id=? AND channel=? AND discord_id IS NULL',sent.id,msg.id,channel));
    }
    return pending.length===10;
  }
  return {pull,push};
}

export function startDiscordBridge() {
  const config=bridgeConfig();
  if (!config) {
    if (process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_CHANNEL_ID) console.warn('Discord bridge disabled. Check DISCORD_CHANNEL_ID, DISCORD_BOT_TOKEN and GOOP_CHAT_ROOM_ID.');
    return;
  }
  const relay=discordRelay(config);
  console.log('Discord bridge enabled for Goop room '+config.room+'.');
  // Separate directions so a missing send permission does not stall incoming replies.
  for(const [direction,work] of Object.entries(relay)) {
    let failures=0;
    async function tick() {
      let delay=pause;
      try { if(await work()) delay=350; failures=0; }
      catch(error) {
        if (!failures || failures%10===0) console.warn('Discord bridge '+direction+' failed ('+(error.status || 'configuration, network or storage')+'). Check channel permissions, IDs and gateway storage.');
        failures++;
        delay=Math.max(error.retryMs || 0,Math.min(120000,pause*2**Math.min(failures,4)));
      }
      setTimeout(tick,delay).unref();
    }
    void tick();
  }
}
