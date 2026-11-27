import {startDiscordBridge} from './discord-bridge.mjs';
import {chat} from './chat.mjs';
import http from 'node:http';
import https from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const webRoot=path.resolve(here,'../site');
const HOST=process.env.HOST||'0.0.0.0';
const PORT=Number(process.env.PORT||4000);
const ORIGINS=(process.env.CORS_ORIGINS||'https://mathscholar.s3.amazonaws.com,https://mathscholar.s3.us-east-1.amazonaws.com,https://mathscholar.s3.us-east-2.amazonaws.com').split(',').map(s=>s.trim()).filter(Boolean);
const targets={
  movies:process.env.MOVIES_URL||'http://movies:3000',
  music:process.env.MUSIC_URL||'http://music:2010',
  manga:process.env.MANGA_URL||'http://manga:3000',
  blox:process.env.BLOX_URL||'http://blox:8080',
};

// Render upstream URLs must be set to each service's full public HTTPS origin.
const probePaths={movies:'/api/sources',music:'/api/music/source',manga:'/healthz',blox:'/blox/'};
async function inspectUpstream(service){
 const raw=targets[service];
 if(!raw || /^http:\/\/(?:movies|music|manga|blox):/.test(raw)){
  return {status:'not_configured',message:`Set ${service.toUpperCase()}_URL to the service's https://...onrender.com address in Render Environment`};
 }
 let dest;
 try{dest=new URL(raw);if(!['https:','http:'].includes(dest.protocol))throw Error('Invalid protocol');}
 catch{return {status:'invalid_url',message:`Invalid ${service.toUpperCase()}_URL`};}
 const checkUrl=new URL(probePaths[service],dest.origin);
 const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),9000);
 try{
  const response=await fetch(checkUrl,{signal:ctrl.signal,redirect:'manual'});
  const ok=response.ok;
  await response.body?.cancel().catch(()=>{});
  return {status:ok?'online':'http_error',httpStatus:response.status,
    configuredHost:dest.host,checkedPath:probePaths[service],
    message:ok?'Service responded':`Upstream returned HTTP ${response.status}. Verify the service, route, and Render configuration.`};
 }catch(err){return {status:'unreachable',configuredHost:dest.host,checkedPath:probePaths[service],message:err.name==='AbortError'?'Timed out (possibly Render waking up)':err.message};}
 finally{clearTimeout(timer)}
}
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.wasm':'application/wasm'};
function cors(req,res){const origin=req.headers.origin;if(origin && (ORIGINS.includes(origin)||ORIGINS.includes('*'))){res.setHeader('Access-Control-Allow-Origin',ORIGINS.includes('*')?'*':origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET,HEAD,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Range');} }
function apiOrigin(req){const proto=(req.headers['x-forwarded-proto']||'http').toString().split(',')[0];return `${proto}://${req.headers.host}`;}
function reply(res,code,data){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function staticFile(p,res){const resolved=path.resolve(webRoot,p.replace(/^\/+/,''));if(!resolved.startsWith(webRoot+path.sep)) {res.writeHead(403);res.end();return;}try{let info=await stat(resolved);if(!info.isFile())throw new Error('not file');res.writeHead(200,{'Content-Type':types[path.extname(resolved)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(await readFile(resolved));}catch{res.writeHead(404);res.end('Not found');}}
function forward(req,res,service,rest){
 let dest=new URL(targets[service]);let requestPath=rest||'/';
 if(!requestPath.startsWith('/'))requestPath='/'+requestPath;
 const scheme=dest.protocol==='https:'?https:http;
 const headers={...req.headers,host:dest.host};
 delete headers.origin;delete headers['content-length'];delete headers['connection'];
 // A playlist is text that needs gateway-relative URLs. Request uncompressed text.
 const mayBeMoviePlaylist=service==='movies' && requestPath.startsWith('/api/proxy?');
 if(mayBeMoviePlaylist)headers['accept-encoding']='identity';
 const upstream=scheme.request({protocol:dest.protocol,hostname:dest.hostname,
   port:dest.port||undefined,method:req.method,path:requestPath,headers,timeout:90000},r=>{
   const responseHeaders={...r.headers};
   delete responseHeaders['access-control-allow-origin'];
   delete responseHeaders['access-control-allow-credentials'];
   delete responseHeaders['transfer-encoding'];delete responseHeaders['connection'];
   if(r.statusCode===404)responseHeaders['x-goop-upstream-404']=service;
   const contentType=String(r.headers['content-type']||'').toLowerCase();
   const isHls=mayBeMoviePlaylist && (contentType.includes('mpegurl') || contentType.includes('vnd.apple.mpegurl')) && r.statusCode===200;
   if(isHls && !r.headers['content-encoding']){
     // x8rr/movies emits root-relative /api/proxy? in its HLS manifest.
     // On Goop Gateway, those requests must pass through /movies/api/proxy?.
     // Applies to media segments, nested manifests, encryption key URIs.
     const chunks=[];let bytes=0;const max=2*1024*1024;
     r.on('data',chunk=>{
       bytes+=chunk.length;
       if(bytes>max){upstream.destroy(new Error('HLS manifest exceeds 2 MB'));return;}
       chunks.push(chunk);
     });
     r.on('end',()=>{
       if(res.destroyed)return;
       const original=Buffer.concat(chunks).toString('utf8');
       const corrected=original.replace(/(^|["'=])\/api\/proxy\?/gm,'$1/movies/api/proxy?');
       delete responseHeaders['content-length'];
       delete responseHeaders['content-encoding'];
       responseHeaders['content-type']='application/vnd.apple.mpegurl; charset=utf-8';
       responseHeaders['cache-control']='no-store';
       res.writeHead(200,responseHeaders);res.end(corrected);
     });
     r.on('error',e=>{if(!res.headersSent){res.writeHead(502);res.end('Playlist response failed: '+e.message)}});
     return;
   }
   res.writeHead(r.statusCode||502,responseHeaders);
   r.pipe(res);
 });
 upstream.on('timeout',()=>upstream.destroy(new Error('Upstream timeout')));
 upstream.on('error',e=>{
   if(!res.headersSent){res.writeHead(502,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Backend unavailable',service,detail:e.message}));}
   else res.destroy(e);
 });
 req.pipe(upstream);
}
const server=http.createServer(async(req,res)=>{
 let pathname;try{pathname=new URL(req.url||'/', 'http://local').pathname;}catch{res.writeHead(400);res.end();return;}
 if(pathname.startsWith('/api/chat/'))return chat(req,res,pathname,ORIGINS);
 cors(req,res);if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end('Read-only gateway');return;}
 if(pathname==='/health')return reply(res,200,{status:'ok',service:'goop-gateway'});
 if(pathname==='/api/ready'){
  const service=new URL(req.url,'http://local').searchParams.get('service');
  if(!Object.hasOwn(targets,service||''))return reply(res,400,{error:'Unknown service'});
  const result=await inspectUpstream(service);
  return reply(res,result.status==='online'?200:503,{service,...result});
 }
 if(pathname==='/api/status'){
  const entries=await Promise.all(['movies','music','manga','blox'].map(async name=>[name,await inspectUpstream(name)]));
  return reply(res,200,{gateway:'ok',services:Object.fromEntries(entries),note:'HTTP reachability does not confirm playback or login.'});
 }
 if(pathname==='/goop-backend-config.json'){
  const root=apiOrigin(req);
  return reply(res,200,{moviesBase:`${root}/movies/`,musicBase:`${root}/music/`,mangaBase:`${root}/manga/`,bloxBase:targets.blox.startsWith('https://')?new URL('/',targets.blox).href:'',gameHost:'',notes:'Blox requires optional service and must launch as a top-level page'});
 }
 // Fixed GitHub game collections. This is a content proxy, not an arbitrary URL proxy.
 const g=pathname.match(/^\/games\/(ugs|seraph|truffled|ckv)\/(.*)$/);
 if(g){
   const full=new URL(req.url||'/', 'http://local');
   let relative;
   try{relative=decodeURIComponent(g[2]);}catch{return reply(res,400,{error:'Invalid path'});}
   if(relative.split('/').some(v=>v==='..'||v==='.')||relative.includes('\\'))return reply(res,400,{error:'Unsafe path'});
   const url=`https://raw.githubusercontent.com/gmshelf/${g[1]}/main/${relative}`;
   try{
     const r=await fetch(url,{signal:AbortSignal.timeout(18000)});
     if(!r.ok){res.writeHead(r.status);res.end('Game file unavailable');return;}
     const ext=path.extname(relative);
     res.writeHead(200,{'Content-Type':types[ext]||r.headers.get('content-type')||'application/octet-stream','Cache-Control':'public, max-age=600'});
     if(r.body)Readable.fromWeb(r.body).pipe(res);else res.end();
   }catch(e){reply(res,502,{error:'Game source unavailable',detail:e.message});}
   return;
 }
 const match=pathname.match(/^\/(movies|music|manga|blox)(\/.*)?$/);
 if(match)return forward(req,res,match[1],(match[2]||'/')+new URL(req.url,'http://local').search);
 await staticFile(pathname==='/'?'index.html':pathname,res);
});
// A dedicated websocket relay for webblox, forwarded only to the configured Blox server.
server.on('upgrade',(req,socket,head)=>{
 if(!req.url?.startsWith('/wisp/'))return socket.destroy();
 const to=new URL(targets.blox),up=http.request({hostname:to.hostname,port:to.port||80,path:req.url,headers:req.headers});
 up.on('upgrade',(response,upSocket,upHead)=>{
  socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(response.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');
  if(head?.length)upSocket.write(head);if(upHead?.length)socket.write(upHead);
  socket.pipe(upSocket);upSocket.pipe(socket);
 });
 up.on('error',()=>socket.destroy());up.end();
});
server.listen(PORT,HOST,()=>console.log(`Goop gateway listening at http://localhost:${PORT}`));

startDiscordBridge();
