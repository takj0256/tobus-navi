import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { decodeGtfsRealtime } from '../js/realtime.js';
import { runScheduledCollection } from '../worker/worker.js';
import { unapprovedMissingKeys } from './phase11-approved-gaps.mjs';
import { AVAILABLE_OBSERVATIONS_POLICY, qualityFromAudit } from './phase11-publication-quality.mjs';
import { atomicJson, readJson, cloudflareClient, sha256 } from './phase11-storage.mjs';

export function rawTimestamp(key) {
  const m = /^raw-v1\/(\d{4}-\d{2}-\d{2})\/(\d{2})\/(\d{2})\.pb$/.exec(key);
  if (!m) throw Error(`Invalid raw key: ${key}`);
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`);
  if (!Number.isFinite(ms)) throw Error('Invalid raw date');
  return ms;
}

export function mergeEvents(a, b) {
  const entries = new Map();
  for (const event of [...a, ...b]) {
    if (!event.event_id) throw Error('Event id missing');
    entries.set(event.event_id, event);
  }
  return [...entries.values()].sort((x, y) => x.timestamp_ms - y.timestamp_ms || x.event_id.localeCompare(y.event_id));
}

async function optionalGet(client, key) {
  try { return await client.get(key); }
  catch (e) { if (/Cloudflare HTTP 404:/.test(e.message)) return null; throw e; }
}

// 96 normal weather writes/UTC day plus 32 uncertain-failure reservations.
// Keep the original total cap; anomaly bursts must not starve current weather.
export function reserveD1Operation(budget, sql) {
  const kind = /^\s*SELECT/i.test(sql) ? 'reads' : 'writes';
  const weather = /^\s*INSERT\s+INTO\s+weather_current\b/i.test(sql);
  const cap = kind === 'writes' && !weather ? 2872 : 3000;
  if ((budget[kind] || 0) >= cap) {
    throw Error(`PC D1 ${kind} daily operation budget exhausted${cap < 3000 ? ' (128 reserved for weather)' : ''}`);
  }
  budget[kind] = (budget[kind] || 0) + 1;
  return kind;
}

export function validateForwardLateFeed(bytes, state, now) {
  const feed = decodeGtfsRealtime(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const time = Number(feed.timestamp) * 1000;
  const previousTime = Math.max(0, ...Object.values(state.vehicles || {}).map(v => Number(v.timestampMs) || 0));
  if (!Number.isFinite(time) || time <= 0 || time < previousTime || time > now + 60000) throw Error('Late raw input is not provably forward; rebuild required');
  for (const v of feed.vehicles || []) {
    const id = v?.vehicle?.id || v.entityId || v?.trip?.tripId;
    if (!id || !v.stopId) continue;
    const p = state.vehicles?.[id];
    const t = Number(v.timestamp || feed.timestamp) * 1000;
    if (!Number.isFinite(t) || t <= 0 || t > now + 60000 || (p && t < Number(p.timestampMs))) throw Error('Late raw input contains older observations; rebuild required');
    if (p && t === Number(p.timestampMs) && (v.stopId !== p.stopId || (v.trip?.tripId || '') !== p.tripId || v.currentStopSequence !== p.stopSequence)) throw Error('Late raw input conflicts at equal timestamp; rebuild required');
  }
  return time;
}

export async function processRaw({ root, client, now = Date.now(), maxObjects = 120, through, fetchImpl = fetch }) {
  const config = await readJson(path.join(root, 'config.json'));
  const start = Date.parse(config.start_at);
  if (!Number.isFinite(start)) throw Error('Processor start_at required');
  const checkpointFile = path.join(root, 'checkpoint.json');
  let cp = await readJson(checkpointFile, null);
  if (!cp) {
    const legacy = await optionalGet(client, 'state/latest.json');
    cp = { version: 1, start_at: config.start_at, cursor: '', seen: {}, state: legacy ? JSON.parse(legacy) : { vehicles: {}, candidates: [] }, pending: {}, count: 0 };
    await atomicJson(checkpointFile, cp);
  }
  if (cp.start_at !== config.start_at) throw Error('start_at differs from checkpoint');
  const cursorMs = cp.cursor ? rawTimestamp(cp.cursor) : start;
  if (now - cursorMs > 70 * 3600000) throw Error('Raw backlog exceeds safe 70-hour retention window; manual recovery from local archive required');
  const end = through ? Date.parse(`${through}T00:00:00+09:00`) + 86400000 : now - 90000;
  if (!Number.isFinite(end) || end > now - 90000) throw Error('Cannot process unsettled/future cutoff');
  const objects = [];
  const listFrom = Math.min(cursorMs, through ? end - 86400000 : end);
  for (let day = Math.floor(listFrom / 86400000) * 86400000; day <= Math.floor(end / 86400000) * 86400000; day += 86400000) {
    objects.push(...await client.list(`raw-v1/${new Date(day).toISOString().slice(0, 10)}/`));
  }
  const eligible = objects.filter(o => rawTimestamp(o.key) >= start && rawTimestamp(o.key) < end).sort((a, b) => a.key.localeCompare(b.key));
  cp.delayed_captures ||= {};
  for (const o of eligible) {
    const metadata = o.custom_metadata || {};
    if (Date.parse(metadata.captured_at) - Date.parse(metadata.scheduled_at) > 120000) {
      cp.delayed_captures[o.key] = { scheduled_at: metadata.scheduled_at, captured_at: metadata.captured_at };
    }
  }
  const late = eligible.filter(o => o.key <= cp.cursor && !cp.seen[o.key]);
  const todo = eligible.filter(o => o.key > cp.cursor);
  const work = [...late, ...todo];
  const budgetFile = path.join(root, 'd1-budget.json');
  let budget = await readJson(budgetFile, {});
  const utcDay = new Date(now).toISOString().slice(0, 10);
  if (budget.day !== utcDay) budget = { day: utcDay, reads: 0, writes: 0 };
  function statement(sql, params = []) {
    async function execute() {
      // Reserve before sending, including uncertain failures. No full profile reads/writes.
      reserveD1Operation(budget, sql);
      await atomicJson(budgetFile, budget);
      const result = await client.operationalQuery(sql, params);
      return result[0];
    }
    return { bind: (...values) => statement(sql, values), run: execute, all: execute, first: async () => (await execute()).results?.[0] || null };
  }
  let active;
  const bucket = {
    async get(key) {
      if (key === 'state/latest.json') return { json: async () => structuredClone(active.state) };
      const data = await optionalGet(client, key);
      if (!data) return null;
      const parsed = JSON.parse(data); // Fail loudly rather than treating corrupt JSON as missing.
      return { json: async () => parsed };
    },
    async put(key, value) {
      const data = JSON.parse(value);
      if (key === 'state/latest.json') { active.state = data; return; }
      const match = /^events\/(\d{4}-\d{2}-\d{2})\/(\d{2})\//.exec(key);
      if (!match) throw Error(`Unexpected processor output: ${key}`);
      const hour = `hourly/${match[1]}/${match[2]}.json`;
      active.pending[hour] = mergeEvents(active.pending[hour] || [], data.events);
    },
  };
  async function publishPending() {
    for (const [key, events] of Object.entries(cp.pending)) {
      const priorBytes = await optionalGet(client, key);
      const prior = priorBytes ? JSON.parse(priorBytes) : { events: [] };
      if (!Array.isArray(prior.events)) throw Error(`Invalid existing hourly: ${key}`);
      const payload = Buffer.from(JSON.stringify({ generated_at: new Date(now).toISOString(), events: mergeEvents(prior.events, events) }));
      await client.ingestPut(key, payload);
      delete cp.pending[key];
      await atomicJson(checkpointFile, cp);
    }
  }
  // Flush a durable prior outbox before extending it. Bound bulk-recovery checkpoints.
  await publishPending();
  let processed = 0;
  for (const object of work.slice(0, maxObjects)) {
    let time = rawTimestamp(object.key);
    const bytes = await client.get(object.key);
    const isLate = object.key <= cp.cursor;
    if (isLate) time = validateForwardLateFeed(bytes, cp.state, now);
    const digest = sha256(bytes);
    const localRaw = path.join(root, 'raw', object.key.slice(7) + '.gz');
    await fs.mkdir(path.dirname(localRaw), { recursive: true });
    const compressed = gzipSync(bytes);
    await fs.writeFile(localRaw + '.tmp', compressed);
    await fs.rename(localRaw + '.tmp', localRaw);
    if (sha256(await fs.readFile(localRaw)) !== sha256(compressed)) throw Error('Local raw archive verification failed');
    active = structuredClone(cp);
    const fresh = now - time <= 5 * 60000;
    if (!fresh && Date.parse(active.state.weather?.fetched_at || '') > time) delete active.state.weather;
    await runScheduledCollection({
      EVENT_BUCKET: bucket, DB: fresh ? { prepare: sql => statement(sql) } : undefined,
      WEATHER_ENABLED: fresh ? 'true' : 'false', R2_MAINTENANCE_ENABLED: 'false',
      WEATHER_FETCH_AT: new Date(now).toISOString(),
      // PC network latency can exceed the Worker-oriented 5s default.
      WEATHER_TIMEOUT_MS: 15000,
      QUERY_TRAFFIC: async (event, anomaly) => {
        if (!config.processor_token || !config.worker_url) throw Error('Traffic bridge configuration missing');
        const r = await fetchImpl(config.worker_url + '/internal/phase11/traffic', {
          method: 'POST', headers: { Authorization: `Bearer ${config.processor_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ event, anomaly }), signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) throw Error(`Traffic bridge HTTP ${r.status}`);
        await r.arrayBuffer();
      },
    }, new Date(time), async (url, init) => url.includes('api-public.odpt.org') ? new Response(bytes) : fetchImpl(url, init));
    active.cursor = object.key > cp.cursor ? object.key : cp.cursor;
    active.seen[object.key] = digest;
    if (isLate) {
      active.late_inputs ||= {};
      active.late_inputs[object.key] = { sha256: digest, feed_at: new Date(time).toISOString(), reconciled_at: new Date(now).toISOString() };
    }
    active.count++;
    if (!fresh) active.replayed_without_live_enrichment = (active.replayed_without_live_enrichment || 0) + 1;
    active.last_processed_at = new Date(now).toISOString();
    await atomicJson(checkpointFile, active); // state + outbox + cursor commit together
    cp = active;
    processed++;
    if (processed % 120 === 0) await publishPending();
  }
  // Outbox is durable before publication. Replays merge by event_id, never add counts.
  await publishPending();
  // Audit expected captures; no fabricated observations and no stale-day success.
  let missing = 0;
  const missingKeys = [];
  const from = Math.max(start, Math.floor((end - 86400000) / 60000) * 60000);
  for (let ms = from; ms + 60000 <= end; ms += 60000) {
    const iso = new Date(ms).toISOString();
    const key = `raw-v1/${iso.slice(0, 10)}/${iso.slice(11, 13)}/${iso.slice(14, 16)}.pb`;
    if (!cp.seen[key] && !todo.some(o => o.key === key)) { missing++; missingKeys.push(key); }
  }
  const partialPolicy = config.publication_policy === AVAILABLE_OBSERVATIONS_POLICY;
  await atomicJson(checkpointFile, cp); // Persist capture timing even when no new input remains.
  const status = { version: 1, checked_at: new Date(now).toISOString(), start_at: config.start_at, cursor: cp.cursor, processed, total_processed: cp.count,
    publication_policy: partialPolicy ? config.publication_policy : 'strict-captures', audit_date: through || null,
    backlog: Math.max(0, work.length - processed), missing_capture_minutes_last_day: missing,
    late_input_reconciliations: cp.late_inputs || {},
    delayed_capture_inputs: cp.delayed_captures,
    missing_raw_keys: missingKeys,
    unapproved_missing_capture_minutes: partialPolicy ? 0 : unapprovedMissingKeys(through, missingKeys).length,
    replayed_without_live_enrichment: cp.replayed_without_live_enrichment || 0,
    pending_hours: Object.keys(cp.pending).length, weather_fetched_at: cp.state.weather?.fetched_at || null,
    weather_error: cp.state.weather_error || null, anomaly_error: cp.state.anomaly_error || null, d1_budget: budget };
  await atomicJson(path.join(root, 'status.json'), status);
  await client.ingestPut('state/processor-v1.json', Buffer.from(JSON.stringify(status)));
  if (through && (status.backlog || status.pending_hours || (!partialPolicy && status.unapproved_missing_capture_minutes))) throw Error(`Daily publication blocked: backlog=${status.backlog}, missing capture minutes=${missing}, unapproved=${status.unapproved_missing_capture_minutes}`);
  if (through && partialPolicy) {
    const audit = { ...status, date_key: through, publication_policy: config.publication_policy };
    qualityFromAudit(through, audit);
    await atomicJson(path.join(root, 'daily-audits', `${through}.json`), audit);
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  if (!root) throw Error('usage: process_phase11_raw.mjs ROOT [--through YYYY-MM-DD]');
  const i = process.argv.indexOf('--through');
  console.log(JSON.stringify(await processRaw({ root, client: await cloudflareClient(), through: i >= 0 ? process.argv[i + 1] : undefined, maxObjects: i >= 0 ? 4320 : 120 })));
}
