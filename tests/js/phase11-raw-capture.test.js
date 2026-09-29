import test from 'node:test';
import assert from 'node:assert/strict';
import { captureRawFeed } from '../../worker/worker.js';

const scheduled = new Date('2026-09-29T00:00:17Z');
function fixture(fetchImpl, options = {}) {
  const logs = [], writes = []; let clock = scheduled.getTime();
  const env = { EVENT_BUCKET: { async put(...args) { writes.push(args); return {}; } } };
  const runtime = { log: e => logs.push(e), clock: () => clock, sleep: async ms => { clock += ms; }, ...options };
  return { logs, writes, env, runtime, run: () => captureRawFeed(env, scheduled, fetchImpl, runtime) };
}
test('transient HTTP recovers once and preserves bytes and both timestamps', async () => {
  let calls = 0;
  const f = fixture(async () => ++calls === 1 ? new Response('', {status:503}) : new Response(new Uint8Array([1,2,3])));
  const result = await f.run();
  assert.equal(result.attempts, 2); assert.equal(f.writes.length, 1);
  assert.deepEqual([...f.writes[0][1]], [1,2,3]);
  const meta = f.writes[0][2].customMetadata;
  assert.equal(meta.scheduled_at, scheduled.toISOString());
  assert.equal(meta.captured_at, '2026-09-29T00:00:17.500Z');
  assert.equal(meta.capture_attempts, '2'); assert.equal(meta.recovered_stage, 'http');
  assert.equal(f.logs[0].outcome, 'retry'); assert.equal(f.logs[0].http_status, 503);
});
test('network exceptions are sanitized and limited to two fetches', async () => {
  let calls=0; const f=fixture(async()=>{calls++;throw Error('secret https://private/token');});
  await assert.rejects(f.run(), /network_error/);
  assert.equal(calls,2); assert.equal(f.writes.length,0);
  assert.ok(!JSON.stringify(f.logs).includes('secret'));assert.ok(!JSON.stringify(f.logs).includes('https'));
});
test('permanent HTTP responses are not retried', async () => {
  for(const status of [400,401,403,404]) {
    let calls=0;const f=fixture(async()=>{calls++;return new Response('',{status});});
    await assert.rejects(f.run(),new RegExp(String(status))); assert.equal(calls,1);assert.equal(f.writes.length,0);
  }
});
test('Retry-After beyond acquisition budget prevents immediate retry', async () => {
  let calls=0;const f=fixture(async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'60'}});});
  await assert.rejects(f.run(),/429/);assert.equal(calls,1);assert.equal(f.logs[0].outcome,'failed');
});
test('fetch timeout returns even if fetch ignores abort, with no later writes', async () => {
  const resolvers=[];const f=fixture(()=>new Promise(resolve=>resolvers.push(resolve)),{attemptMs:10});
  await assert.rejects(f.run(),/fetch: timeout/);assert.equal(resolvers.length,2);
  resolvers.forEach(resolve=>resolve(new Response(new Uint8Array([1]))));
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.writes.length,0);
});
test('body timeout is bounded and logged separately from fetch', async () => {
  let cancelled=0;const f=fixture(async()=>new Response(new ReadableStream({cancel(){cancelled++;}})),{attemptMs:10});
  await assert.rejects(f.run(),/body: timeout/);assert.equal(cancelled,2);assert.equal(f.writes.length,0);
  assert.ok(f.logs.every(e=>e.stage==='body'));
});
test('empty and oversized payloads stop without retries', async () => {
  for(const size of [0,524289]) {
    let calls=0;const f=fixture(async()=>{calls++;return new Response(new Uint8Array(size));});
    await assert.rejects(f.run(),/empty_body|size_exceeded/);assert.equal(calls,1);assert.equal(f.writes.length,0);
  }
});
test('stream size is checked incrementally and cancelled', async () => {
  let cancelled=false;const f=fixture(async()=>new Response(new ReadableStream({
    start(c){c.enqueue(new Uint8Array(524288));c.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}
  })));
  await assert.rejects(f.run(),/size_exceeded/);assert.equal(cancelled,true);assert.equal(f.writes.length,0);
});
test('exact size limit is accepted', async () => {
  const f=fixture(async()=>new Response(new Uint8Array(524288)));assert.equal((await f.run()).bytes,524288);
});
test('uncertain storage failure never refetches or repeats PUT', async () => {
  let calls=0,puts=0;const f=fixture(async()=>{calls++;return new Response(new Uint8Array([1]));});
  f.env.EVENT_BUCKET.put=async()=>{puts++;throw Error('private storage detail');};
  await assert.rejects(f.run(),/storage: put_failed/);assert.equal(calls,1);assert.equal(puts,1);
  assert.equal(f.logs.at(-1).stage,'storage');assert.ok(!JSON.stringify(f.logs).includes('private'));
});
test('duplicate retains the first object and is explicitly logged', async () => {
  const f=fixture(async()=>new Response(new Uint8Array([1])));f.env.EVENT_BUCKET.put=async(k,b,o)=>{assert.equal(o.onlyIf.etagDoesNotMatch,'*');return null;};
  assert.equal((await f.run()).duplicate,true);assert.equal(f.logs.at(-1).outcome,'duplicate');
});
test('elapsed acquisition budget prevents retry after slow failure', async () => {
  let time=scheduled.getTime(),calls=0;
  const f=fixture(async()=>{calls++;time+=20000;throw Error('network');},{clock:()=>time});
  await assert.rejects(f.run(),/network_error/);assert.equal(calls,1);
});
