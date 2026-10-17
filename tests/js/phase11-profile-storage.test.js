import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {packProfileGeneration,validatePackedLocalObject} from '../../tools/pack_phase11_profiles.mjs';
import {publishPhase11Json} from '../../tools/publish_phase11_json_to_r2.mjs';
import {packProfilePayload,unpackProfilePayload,validatePackedStorage,validatePackedPayload} from '../../js/phase11-profile-codec.js';
import {decodePackedProfileObject} from '../../worker/profile-storage-v2.js';
import worker,{readProfilesFromR2} from '../../worker/worker.js';
const sha=b=>createHash('sha256').update(b).digest('hex');

async function fixture(t,generatedAt='2026-10-17T00:00:00Z') {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'phase11-pack-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const generation=generatedAt.replaceAll(':','-');
  const profile={segment_key:'r|0|a>b',confidence:0.8123456789012345,median_seconds:120,p25_seconds:90,p75_seconds:150,sample_count:28,generated_at:generatedAt};
  const weather={route_id:'r',direction_id:0,weather_class:'dry',temperature_band:'mild',adjustment_ratio:1.1,confidence:0.8,generated_at:generatedAt};
  async function payload(kind,rows,relative) {
    const b=Buffer.from(JSON.stringify({version:1,generated_at:generatedAt,[kind]:rows}));
    const file=path.join(root,'generations',generation,relative);
    await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,b);
    return {path:relative,bytes:b.length,sha256:sha(b),count:rows.length};
  }
  const shard=await payload('profiles',[profile],'profiles/weekday/0800.json');
  const wd=await payload('weather_profiles',[weather],'weather-profiles.json');
  const manifest={version:1,format:'phase11-profile-shards',generation,generated_at:generatedAt,source_objects:28,source_dates:['2026-10-16'],profiles:{count:1},weather_profiles:{count:1},quality:{missing:5},shards:[{...shard,day_type:'weekday',time_bin:'08:00'}],weather:wd};
  await fs.writeFile(path.join(root,'current.json'),JSON.stringify(manifest));
  return {root,manifest,profile,weather};
}
async function packedFixture(t,at) {
  const f=await fixture(t,at);await packProfileGeneration(f.root,f.root);
  f.packed=JSON.parse(await fs.readFile(path.join(f.root,'current.json')));
  return f;
}
test('gzip/column packing is byte-exact and shares content across generation dates',async t=>{
  const a=await packedFixture(t),b=await packedFixture(t,'2026-10-18T00:00:00Z');
  assert.equal(a.packed.shards[0].storage.key,b.packed.shards[0].storage.key);
  assert.equal(a.packed.weather.storage.key,b.packed.weather.storage.key);
  assert.deepEqual(a.packed.profiles,a.manifest.profiles);
  assert.deepEqual(a.packed.quality,a.manifest.quality);
  assert.deepEqual(a.packed.source_dates,a.manifest.source_dates);
  for(const [d,kind] of [[a.packed.shards[0],'profiles'],[a.packed.weather,'weather_profiles']]){
    const z=await validatePackedLocalObject(a.root,d,a.packed.generated_at,kind);
    const p=await decodePackedProfileObject({size:z.length,arrayBuffer:async()=>z},d.storage);
    const original=await fs.readFile(path.join(a.root,'generations',a.manifest.generation,d.path),'utf8');
    assert.equal(JSON.stringify(unpackProfilePayload(p,a.packed.generated_at)),original);
  }
  assert.deepEqual(unpackProfilePayload(packProfilePayload({version:1,generated_at:'x',profiles:[]},'profiles','x'),'x'),{version:1,generated_at:'x',profiles:[]});
});
test('bad columns, paths, sizes, source integrity and corrupt gzip fail closed',async t=>{
  assert.throws(()=>packProfilePayload({version:1,generated_at:'x',profiles:[{generated_at:'y'}]},'profiles','x'));
  assert.throws(()=>validatePackedPayload({version:2,kind:'profiles',columns:['__proto__','generated_at'],rows:[[1]]},'profiles',1));
  const f=await packedFixture(t),d=f.packed.shards[0],z=await fs.readFile(path.join(f.root,d.storage.key));
  assert.throws(()=>validatePackedStorage({...d.storage,key:'../bad'}));
  assert.throws(()=>validatePackedStorage({...d.storage,bytes:10**9}));
  await assert.rejects(decodePackedProfileObject({size:z.length,arrayBuffer:async()=>Buffer.alloc(z.length)},d.storage),/SHA/);
  await assert.rejects(decodePackedProfileObject({size:z.length,arrayBuffer:async()=>z},{...d.storage,decoded_bytes:10}),/bound/);
  const bomb=gzipSync(Buffer.alloc(10000));const hash=sha(bomb);
  await assert.rejects(decodePackedProfileObject({size:bomb.length,arrayBuffer:async()=>bomb},{key:`blobs/gzip/${hash}.json.gz`,encoding:'gzip',bytes:bomb.length,sha256:hash,decoded_bytes:100}),/bound/);
  await fs.writeFile(path.join(f.root,d.storage.key),Buffer.alloc(z.length));
  await assert.rejects(validatePackedLocalObject(f.root,d,f.packed.generated_at,'profiles'),/hash/);
  const source=await fixture(t);source.manifest.shards[0].path='../outside';
  await fs.writeFile(path.join(source.root,'current.json'),JSON.stringify(source.manifest));
  await assert.rejects(packProfileGeneration(source.root,source.root),/Unsafe/);
});
test('Worker reads compressed profiles/weather without changing their values',async t=>{
  const f=await packedFixture(t),objects=new Map([['profiles-v1/current.json',Buffer.from(JSON.stringify(f.packed))]]);
  for(const d of [...f.packed.shards,f.packed.weather])for(const s of [d.storage,d.read_storage])objects.set(`profiles-v1/${s.key}`,await fs.readFile(path.join(f.root,s.key)));
  const db={prepare(sql){return {bind(){return this;},async all(){return {results:[]};},async first(){return sql.includes('weather_current')?{observed_at:'2026-10-19T23:07:00Z',weather_class:'dry',temperature_band:'mild'}:null;}};}};
  const env={DB:db,EVENT_BUCKET:{async get(key){const b=objects.get(key);return b?{size:b.length,arrayBuffer:async()=>b,json:async()=>JSON.parse(b)}:null;}}};
  const res=await worker.fetch(new Request('https://test/api/v1/estimates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({at:'2026-10-19T23:07:00Z',segments:[{segment_key:f.profile.segment_key,route_id:'r',direction_id:0}]})}),env,{});
  const body=await res.json();assert.equal(body.sources.profiles,'r2-json');assert.equal(body.sources.weather_profiles,'r2-json');
  assert.equal(body.profile_generation,f.packed.generation);assert.deepEqual(body.estimates[0].profile,f.profile);
  for(const [key,value] of Object.entries(f.weather))assert.equal(body.estimates[0].weather[key],value);
  assert.equal(body.estimates[0].weather.active,true);
});
test('publisher stages safely, reuses shared blobs, guards current and never overwrites corrupt objects',async t=>{
  const a=await packedFixture(t),b=await packedFixture(t,'2026-10-18T00:00:00Z');
  const objects=new Map(),puts=[];
  const server=http.createServer(async(req,res)=>{
    const key=decodeURI(req.url.slice(1));
    if(req.method==='GET'){if(!objects.has(key)){res.writeHead(404);res.end();return;}res.end(objects.get(key));return;}
    const chunks=[];for await(const c of req)chunks.push(c);objects.set(key,Buffer.concat(chunks));puts.push(key);res.end('{}');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const options={apiBase:`http://127.0.0.1:${server.address().port}`,token:'test',retryAttempts:1};
  const staged=await publishPhase11Json(a.root,{...options,switchCurrent:false});assert.equal(staged.currentSwitched,false);assert.ok(!objects.has('profiles-v1/current.json'));
  await publishPhase11Json(a.root,options);assert.equal(puts.at(-1),'profiles-v1/current.json');
  const second=await publishPhase11Json(b.root,{...options,expectedCurrentGeneration:a.packed.generation});assert.equal(second.reusedObjects,4);assert.equal(second.uploadedObjects,2);
  await assert.rejects(publishPhase11Json(a.root,{...options,expectedCurrentGeneration:'changed'}),/Current changed/);
  assert.equal(JSON.parse(objects.get('profiles-v1/current.json')).generation,b.packed.generation);
  objects.set(`profiles-v1/${a.packed.shards[0].storage.key}`,Buffer.from('bad'));
  await assert.rejects(publishPhase11Json(a.root,options),/differs/);
  assert.equal(JSON.parse(objects.get('profiles-v1/current.json')).generation,b.packed.generation);
  const candidate={...a.packed,candidate_only:true};await fs.writeFile(path.join(a.root,'current.json'),JSON.stringify(candidate));
  await assert.rejects(publishPhase11Json(a.root,options),/candidate/);
});
test('shared blob caches never retain a different generation timestamp; missing blobs fall back',async t=>{
  const a=await packedFixture(t),b=await packedFixture(t,'2026-10-18T00:00:00Z');
  const z=await fs.readFile(path.join(a.root,a.packed.shards[0].read_storage.key));
  let manifest=a.packed,blobReads=0;
  const bucket={async get(key){if(key.endsWith('current.json'))return {json:async()=>manifest};blobReads++;return {size:z.length,arrayBuffer:async()=>z};}};
  for(const f of [a,b]){
    manifest=f.packed;
    if(f===b)await new Promise(resolve=>setTimeout(resolve,1100));
    const result=await readProfilesFromR2(bucket,[f.profile.segment_key],Date.parse('2026-10-19T23:07:00Z'),new Set(),{PROFILE_MANIFEST_CACHE_SECONDS:1});
    assert.equal(result.profiles.get(f.profile.segment_key).generated_at,f.packed.generated_at);
  }
  assert.equal(blobReads,1);
  const db={prepare(sql){return {bind(){return this;},async all(){return {results:sql.includes('FROM profiles')?[a.profile]:[]};},async first(){return null;}};}};
  const res=await worker.fetch(new Request('https://test/api/v1/estimates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({at:'2026-10-19T23:07:00Z',segments:[{segment_key:a.profile.segment_key}]})}),{DB:db,EVENT_BUCKET:{async get(key){return key.endsWith('current.json')?{json:async()=>a.packed}:null;}}},{});
  const body=await res.json();assert.equal(body.sources.profiles,'d1');assert.equal(body.estimates[0].profile.confidence,a.profile.confidence);
});
test('scheduled opt-in aggregation generates packed current and keeps history candidates denied',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'phase11-pack-cli-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const input=path.join(root,'input'),output=path.join(root,'output');await fs.mkdir(input);
  await fs.writeFile(path.join(input,'2026-10-16.json'),JSON.stringify({version:2,date_key:'2026-10-16',groups:[{segment_key:'r|0|a>b',route_id:'r',direction_id:0,from_stop_id:'a',to_stop_id:'b',day_type:'weekday',time_bin:'08:00',samples:[[100,Date.now()-1000],[120,Date.now()-2000],[140,Date.now()-3000]]}]}));
  const run=spawnSync(process.execPath,[path.resolve('tools/aggregate_phase11_json.mjs'),input,output],{env:{...process.env,PHASE11_PROFILE_STORAGE:'packed-v2'},encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);const m=JSON.parse(await fs.readFile(path.join(output,'current.json')));
  assert.equal(m.version,2);assert.equal(m.format,'phase11-profile-shards-v2');assert.equal(m.profiles.count,1);
  assert.ok(run.stdout.includes(m.generation));await validatePackedLocalObject(output,m.shards[0],m.generated_at,'profiles');
  const env={PROFILE_MANIFEST_GENERATION:m.generation};let requested;
  await readProfilesFromR2({async get(key){requested=key;return {json:async()=>({...m,shards:[]})};}},[],Date.now(),new Set(),env);
  assert.equal(requested,`profiles-v1/generations/${m.generation}/manifest.json`);
  await assert.rejects(readProfilesFromR2({},[],Date.now(),new Set(),{PROFILE_MANIFEST_GENERATION:'../bad'}),/invalid/);
});
