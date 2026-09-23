import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import worker, { runScheduledCollection, captureRawFeed } from '../../worker/worker.js';
import { processRaw, rawTimestamp, mergeEvents } from '../../tools/process_phase11_raw.mjs';
import { atomicJson, readJson } from '../../tools/phase11-storage.mjs';

function varint(n) { const a=[]; n=BigInt(n); while(n>127n){a.push(Number(n&127n)|128);n>>=7n;}return [...a,Number(n)]; }
const vi=(f,n)=>[...varint(f*8),...varint(n)];
const msg=(f,a)=>[...varint(f*8+2),...varint(a.length),...a];
const str=(f,s)=>msg(f,[...new TextEncoder().encode(s)]);
function feed(time, seq) {
  const vehicle=[...msg(1,[...str(1,'t'),...str(5,'r')]),...vi(3,seq),...vi(5,time/1000),...str(7,'s'+seq),...msg(8,str(1,'v'))];
  return Buffer.from([...msg(1,[...str(1,'2.0'),...vi(3,time/1000)]),...msg(2,[...str(1,'e'),...msg(4,vehicle)])]);
}
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'phase11-raw-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const start=Date.parse('2026-09-23T00:00Z');
  await atomicJson(path.join(root,'config.json'),{start_at:new Date(start).toISOString()});
  const values=new Map([
    ['raw-v1/2026-09-23/00/00.pb',feed(start,1)],
    ['raw-v1/2026-09-23/00/01.pb',feed(start+60000,2)],
  ]);
  const client={
    async get(k){if(!values.has(k))throw Error('Cloudflare HTTP 404: '+k);return values.get(k);},
    async list(p){return [...values].filter(([k])=>k.startsWith(p)).map(([key,b])=>({key,size:b.length}));},
    async ingestPut(k,b){values.set(k,b);},
    async operationalQuery(){return [{results:[],meta:{rows_written:1}}];},
  };
  return {root,start,client,values,now:start+600000};
}
test('raw capture does not decode or access D1/weather and preserves first delivery',async()=>{
  const values=new Map();let count=0;
  const env={COLLECTION_MODE:'raw-v1',DB:{prepare(){throw Error('D1 forbidden');}},EVENT_BUCKET:{async put(k,b,opts){assert.equal(opts.onlyIf.etagDoesNotMatch,'*');if(values.has(k))return null;values.set(k,b);return {key:k};}}};
  const f=async()=>{count++;return new Response(new Uint8Array([255,255]));};
  const now=new Date('2026-09-23T00:00:12Z');
  assert.equal((await runScheduledCollection(env,now,f)).raw,true);
  assert.equal((await captureRawFeed(env,now,f)).duplicate,true);
  assert.equal(count,2);assert.equal(values.size,1);
});
test('raw capture rejects upstream failure and oversize without writing',async()=>{
  const env={EVENT_BUCKET:{put(){throw Error('must not write');}}};
  await assert.rejects(captureRawFeed(env,new Date(),async()=>new Response('',{status:503})),/503/);
  await assert.rejects(captureRawFeed(env,new Date(),async()=>new Response(new Uint8Array(524289))),/size/);
});
test('ordered replay, local archive and repeated runs do not duplicate events',async t=>{
  const f=await fixture(t);
  const a=await processRaw(f); assert.equal(a.processed,2);
  const hour=JSON.parse(f.values.get('hourly/2026-09-23/00.json'));assert.equal(hour.events.length,1);assert.equal(hour.events[0].seconds,60);
  assert.equal((await processRaw(f)).processed,0);
  assert.equal(JSON.parse(f.values.get('hourly/2026-09-23/00.json')).events.length,1);
  assert.ok((await fs.stat(path.join(f.root,'raw/2026-09-23/00/01.pb.gz'))).size>0);
});
test('failed publication retains outbox; restart publishes once',async t=>{
  const f=await fixture(t),put=f.client.ingestPut;
  f.client.ingestPut=async(k,b)=>{if(k.startsWith('hourly'))throw Error('network');return put(k,b);};
  await assert.rejects(processRaw(f),/network/);
  assert.equal(Object.keys((await readJson(path.join(f.root,'checkpoint.json'))).pending).length,1);
  f.client.ingestPut=put;
  await processRaw(f);
  assert.equal(JSON.parse(f.values.get('hourly/2026-09-23/00.json')).events.length,1);
});
test('malformed raw input stops cursor and remains archived',async t=>{
  const f=await fixture(t);f.values.set('raw-v1/2026-09-23/00/01.pb',Buffer.from([10,127]));
  await assert.rejects(processRaw(f));
  assert.equal((await readJson(path.join(f.root,'checkpoint.json'))).cursor,'raw-v1/2026-09-23/00/00.pb');
});
test('late input before cursor is never silently skipped',async t=>{
  const f=await fixture(t);f.values.delete('raw-v1/2026-09-23/00/00.pb');await processRaw(f);
  f.values.set('raw-v1/2026-09-23/00/00.pb',feed(f.start,1));
  await assert.rejects(processRaw(f),/Late raw/);
});
test('retention expiration and future cutoffs stop processing',async t=>{
  const f=await fixture(t);
  await assert.rejects(processRaw({...f,now:f.start+71*3600000}),/retention/);
  await assert.rejects(processRaw({...f,through:'2026-09-23'}),/future/);
});
test('daily gate refuses missing capture minutes',async t=>{
  const f=await fixture(t);
  await assert.rejects(processRaw({...f,now:f.start+20*3600000,through:'2026-09-23'}),/missing capture/);
});
test('merge validates ids and raw keys are confined',()=>{
  assert.throws(()=>rawTimestamp('../secret'),/Invalid/);
  assert.throws(()=>mergeEvents([{}],[]),/id/);
  assert.equal(mergeEvents([{event_id:'a',timestamp_ms:1}],[{event_id:'a',timestamp_ms:1}]).length,1);
});
test('traffic bridge is not publicly callable',async()=>{
  const req=new Request('https://test/internal/phase11/traffic',{method:'POST',body:'{}'});
  assert.equal((await worker.fetch(req,{PHASE11_PROCESSOR_TOKEN:'test'},{})).status,401);
  assert.equal((await worker.fetch(req,{},{})).status,404);
  const auth=new Request('https://test/internal/phase11/traffic',{method:'POST',headers:{Authorization:'Bearer test'},body:'null'});
  assert.equal((await worker.fetch(auth,{PHASE11_PROCESSOR_TOKEN:'test'},{})).status,400);
});

test('existing hourly records survive replay and capped runs retain backlog',async t=>{
  const f=await fixture(t);
  f.values.set('hourly/2026-09-23/00.json',Buffer.from(JSON.stringify({events:[{event_id:'legacy',timestamp_ms:1}]})));
  assert.equal((await processRaw({...f,maxObjects:1})).backlog,1);
  await processRaw(f);
  assert.equal(JSON.parse(f.values.get('hourly/2026-09-23/00.json')).events.length,2);
});

test('R2 authentication error does not advance input cursor',async t=>{
  const f=await fixture(t),get=f.client.get;
  f.client.get=async k=>{if(k.endsWith('01.pb'))throw Error('Cloudflare HTTP 401');return get(k);};
  await assert.rejects(processRaw(f),/401/);
  assert.equal((await readJson(path.join(f.root,'checkpoint.json'))).cursor,'raw-v1/2026-09-23/00/00.pb');
});

test('PC weather enrichment tolerates a response slower than five seconds',async t=>{
  const f=await fixture(t);
  const result=await processRaw({...f,now:f.start+180000,fetchImpl:async(url,init)=>{
    assert.match(String(url),/open-meteo/);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(resolve,5200);
      init.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('weather timeout'));},{once:true});
    });
    return Response.json({latitude:35.7,longitude:139.7,current:{temperature_2m:22,time:'2026-09-23T00:00'}});
  }});
  assert.equal(result.weather_error,null);
  assert.equal(result.weather_fetched_at,new Date(f.start+180000).toISOString());
});
