import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import worker, { runScheduledCollection, captureRawFeed, collectSegmentEvents } from '../../worker/worker.js';
import { processRaw, rawTimestamp, mergeEvents, validateForwardLateFeed } from '../../tools/process_phase11_raw.mjs';
import { decodeGtfsRealtime } from '../../js/realtime.js';
import { atomicJson, readJson } from '../../tools/phase11-storage.mjs';
import { approvedMissingKeys } from '../../tools/phase11-approved-gaps.mjs';

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
test('bulk recovery flushes at 120 inputs and resumes a failed durable outbox without duplicates',async t=>{
  const f=await fixture(t);
  for(let i=2;i<125;i++) {
    const iso=new Date(f.start+i*60000).toISOString();
    f.values.set(`raw-v1/${iso.slice(0,10)}/${iso.slice(11,13)}/${iso.slice(14,16)}.pb`,feed(f.start+i*60000,i+1));
  }
  const put=f.client.ingestPut;
  f.client.ingestPut=async(k,b)=>{if(k.startsWith('hourly'))throw Error('network');return put(k,b);};
  await assert.rejects(processRaw({...f,now:f.start+130*60000,maxObjects:200}),/network/);
  assert.equal((await readJson(path.join(f.root,'checkpoint.json'))).count,120);
  f.client.ingestPut=put;
  const result=await processRaw({...f,now:f.start+130*60000,maxObjects:200});
  assert.equal(result.total_processed,125);assert.equal(result.pending_hours,0);
  const events=[...f.values].filter(([k])=>k.startsWith('hourly/')).flatMap(([,b])=>JSON.parse(b).events);
  assert.equal(events.length,124);assert.equal(new Set(events.map(e=>e.event_id)).size,124);
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
test('forward late capture is reconciled once without rewinding the cursor',async t=>{
  const f=await fixture(t);
  f.values.delete('raw-v1/2026-09-23/00/00.pb');
  await processRaw(f);
  f.values.set('raw-v1/2026-09-23/00/00.pb',feed(f.start+120000,3));
  const result=await processRaw(f);
  assert.equal(result.processed,1);
  assert.equal(result.cursor,'raw-v1/2026-09-23/00/01.pb');
  assert.equal(result.backlog,0);
  assert.equal(Object.keys(result.late_input_reconciliations).length,1);
  assert.equal(JSON.parse(f.values.get('hourly/2026-09-23/00.json')).events.length,1);
  assert.equal((await processRaw(f)).processed,0);
});
test('late validation rejects equal-time conflicting stops and future observations',()=>{
  const time=Date.parse('2026-09-23T00:00Z');
  const state={vehicles:{v:{timestampMs:time,stopId:'s2',tripId:'t',stopSequence:2}}};
  assert.throws(()=>validateForwardLateFeed(feed(time,3),state,time+600000),/conflicts/);
  assert.throws(()=>validateForwardLateFeed(feed(time+3600000,3),state,time),/forward/);
});
test('collector keeps a newer state when later delivery carries an older timestamp',()=>{
  const time=Date.parse('2026-09-23T00:00Z'),state={};
  const decode=b=>decodeGtfsRealtime(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
  collectSegmentEvents(decode(feed(time+120000,3)),state,time+120000);
  assert.deepEqual(collectSegmentEvents(decode(feed(time+60000,2)),state,time+180000),[]);
  assert.equal(state.vehicles.v.stopId,'s3');
  assert.equal(state.vehicles.v.timestampMs,time+120000);
});
test('late delivery with any older vehicle leaves the checkpoint unchanged',async t=>{
  const f=await fixture(t);
  await processRaw(f);
  const before=await fs.readFile(path.join(f.root,'checkpoint.json'),'utf8');
  f.values.set('raw-v1/2026-09-23/00/00.pb',feed(f.start,1));
  const cp=JSON.parse(before);delete cp.seen['raw-v1/2026-09-23/00/00.pb'];
  await atomicJson(path.join(f.root,'checkpoint.json'),cp);
  const expected=await fs.readFile(path.join(f.root,'checkpoint.json'),'utf8');
  await assert.rejects(processRaw(f),/Late raw/);
  assert.equal(await fs.readFile(path.join(f.root,'checkpoint.json'),'utf8'),expected);
});
test('delayed capture metadata survives in status even for an already seen input',async t=>{
  const f=await fixture(t);
  await processRaw(f);
  const list=f.client.list;
  f.client.list=async p=>(await list(p)).map(o=>({...o,custom_metadata:{scheduled_at:'2026-09-23T00:00:59Z',captured_at:'2026-09-23T00:04:00Z'}}));
  const result=await processRaw(f);
  assert.equal(result.processed,0);
  assert.equal(Object.keys(result.delayed_capture_inputs).length,2);
  assert.equal(Object.keys((await readJson(path.join(f.root,'checkpoint.json'))).delayed_captures).length,2);
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
test('available-observation policy records missing captures but still blocks backlog',async t=>{
 const f=await fixture(t),config={start_at:new Date(f.start).toISOString(),publication_policy:'available-observations-v1'};
 await atomicJson(path.join(f.root,'config.json'),config);
 const opts={...f,now:f.start+20*3600000,through:'2026-09-23'};
 await assert.rejects(processRaw({...opts,maxObjects:1}),/backlog=1/);
 const result=await processRaw(opts);assert.ok(result.missing_capture_minutes_last_day>0);assert.equal(result.unapproved_missing_capture_minutes,0);assert.equal(result.audit_date,'2026-09-23');
 const audit=await readJson(path.join(f.root,'daily-audits/2026-09-23.json'));assert.equal(audit.backlog,0);assert.equal(audit.missing_raw_keys.length,result.missing_capture_minutes_last_day);
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

test('daily gate allows the exact approved gap but still rejects another gap',async t=>{
  const f=await fixture(t),day='2026-09-26',start=Date.parse(day+'T00:00+09:00'),seen={};
  for(let i=0;i<1440;i++){const iso=new Date(start+i*60000).toISOString();seen[`raw-v1/${iso.slice(0,10)}/${iso.slice(11,13)}/${iso.slice(14,16)}.pb`]='test-hash';}
  delete seen[approvedMissingKeys(day)[0]];
  await atomicJson(path.join(f.root,'config.json'),{start_at:new Date(start).toISOString()});
  const checkpoint={version:1,start_at:new Date(start).toISOString(),cursor:'raw-v1/2026-09-26/15/01.pb',seen,state:{vehicles:{},candidates:[]},pending:{},count:1439};
  await atomicJson(path.join(f.root,'checkpoint.json'),checkpoint);
  const opts={...f,now:start+28*3600000,through:day};
  const result=await processRaw(opts);assert.equal(result.missing_capture_minutes_last_day,1);assert.equal(result.unapproved_missing_capture_minutes,0);
  delete checkpoint.seen['raw-v1/2026-09-26/01/55.pb'];
  await atomicJson(path.join(f.root,'checkpoint.json'),checkpoint);
  await assert.rejects(processRaw(opts),/unapproved=1/);
});
