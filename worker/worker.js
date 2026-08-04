import { decodeGtfsRealtime } from "../js/realtime.js";
import {
  buildCorrectionRatio,
  buildWeeklyProfile,
  confirmPhase11Anomaly,
  detectPhase11Anomaly,
  phase11DayType,
  phase11SegmentKey,
  phase11TimeBin,
} from "../js/phase11.js";

const SOURCE = "https://api-public.odpt.org/api/v4/gtfs/realtime/ToeiBus";
const UPSTREAM_TIMEOUT_MS = 8_000;
const STALE_CACHE_SECONDS = 90;
const EVENT_RETENTION_DAYS = 28;
const STATE_KEY = "state/latest.json";

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(env) });
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, phase11: Boolean(env.DB && env.EVENT_BUCKET) }, 200, env);
    }
    if (url.pathname === "/api/v1/estimates" && request.method === "POST") {
      return handleEstimateBatch(request, env);
    }
    if (url.pathname === "/api/v1/profiles" && request.method === "GET") {
      return handleSingleEstimate(url, env, "profile");
    }
    if (url.pathname === "/api/v1/corrections" && request.method === "GET") {
      return handleSingleEstimate(url, env, "correction");
    }
    if (url.pathname !== "/" || request.method !== "GET") {
      return new Response("Not Found", { status: 404, headers: corsHeaders(env) });
    }
    return proxyRealtime(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledCollection(env, new Date(controller.scheduledTime || Date.now())));
  },
};

export async function runScheduledCollection(env, now = new Date(), fetchImpl = fetch) {
  if (!env.EVENT_BUCKET) return { enabled: false, events: 0 };
  const response = await fetchWithTimeout(SOURCE, UPSTREAM_TIMEOUT_MS, fetchImpl);
  if (!response.ok) throw new Error(`ODPT upstream HTTP ${response.status}`);
  const feed = decodeGtfsRealtime(await response.arrayBuffer());
  const state = await readJsonObject(env.EVENT_BUCKET, STATE_KEY, { vehicles: {}, candidates: [] });
  const events = collectSegmentEvents(feed, state, now.getTime());

  if (events.length) {
    if (env.DB) await processAnomalies(events, state, env, now, fetchImpl);
    const key = minuteEventKey(now);
    await env.EVENT_BUCKET.put(key, JSON.stringify({ generated_at: now.toISOString(), events }));
  }
  state.candidates = (state.candidates || []).filter((item) => Number(item.timestampMs) >= now.getTime() - 10 * 60_000).slice(-200);
  await env.EVENT_BUCKET.put(STATE_KEY, JSON.stringify(state));

  if (now.getUTCMinutes() < 2) await compactPreviousHour(env.EVENT_BUCKET, now);
  const tokyo = tokyoClock(now);
  if (tokyo.hour === 4 && tokyo.minute < 2 && env.DB) await aggregateProfiles(env, now);
  return { enabled: true, events: events.length };
}

export function collectSegmentEvents(feed, state, nowMs = Date.now()) {
  const events = [];
  state.vehicles ||= {};
  for (const vehicle of feed?.vehicles || []) {
    const vehicleId = vehicle?.vehicle?.id || vehicle.entityId || vehicle?.trip?.tripId;
    const timestampMs = Number(vehicle.timestamp || feed.timestamp || 0) * 1000;
    if (!vehicleId || !timestampMs || !vehicle.stopId) continue;
    const current = {
      vehicleId,
      tripId: vehicle?.trip?.tripId || "",
      routeId: vehicle?.trip?.routeId || "route",
      directionId: vehicle?.trip?.directionId ?? "",
      stopId: vehicle.stopId,
      stopSequence: vehicle.currentStopSequence,
      timestampMs,
      latitude: Number(vehicle?.position?.latitude),
      longitude: Number(vehicle?.position?.longitude),
    };
    const previous = state.vehicles[vehicleId];
    state.vehicles[vehicleId] = current;
    if (!previous || previous.stopId === current.stopId || previous.tripId !== current.tripId) continue;
    if (Number.isFinite(Number(previous.stopSequence)) && Number.isFinite(Number(current.stopSequence))
      && Number(current.stopSequence) - Number(previous.stopSequence) !== 1) continue;
    const seconds = (current.timestampMs - Number(previous.timestampMs)) / 1000;
    if (!Number.isFinite(seconds) || seconds < 15 || seconds > 1800) continue;
    const routeId = current.routeId || previous.routeId || "route";
    const directionId = current.directionId ?? previous.directionId ?? "";
    events.push({
      event_id: `${vehicleId}:${current.tripId}:${current.stopSequence}:${current.timestampMs}`,
      vehicle_id: vehicleId,
      trip_id: current.tripId,
      route_id: routeId,
      direction_id: directionId,
      from_stop_id: previous.stopId,
      to_stop_id: current.stopId,
      segment_key: phase11SegmentKey(routeId, directionId, previous.stopId, current.stopId),
      seconds,
      timestamp_ms: current.timestampMs,
      observed_at: new Date(current.timestampMs).toISOString(),
      latitude: midpoint(previous.latitude, current.latitude),
      longitude: midpoint(previous.longitude, current.longitude),
      anomalous: false,
    });
  }
  for (const [vehicleId, value] of Object.entries(state.vehicles)) {
    if (Number(value.timestampMs) < nowMs - 30 * 60_000) delete state.vehicles[vehicleId];
  }
  return events;
}

async function processAnomalies(events, state, env, now, fetchImpl) {
  const profileMap = await readProfilesForSegments(env.DB, events.map((event) => event.segment_key), now.getTime(), holidaySet(env));
  for (const event of events) {
    const profile = profileMap.get(event.segment_key);
    if (!profile || Number(profile.confidence) < 0.3) continue;
    const expected = Number(profile.profile_seconds || profile.median_seconds);
    const anomaly = detectPhase11Anomaly(event.seconds, expected, profile);
    event.anomalous = anomaly.candidate;
    if (!anomaly.candidate) continue;

    const cachedTraffic = await readTrafficCache(event.segment_key, env, now.getTime());
    const prior = (state.candidates || []).map((item) => ({
      ...item,
      sameVehicleConsecutive: item.vehicleId === event.vehicle_id,
      sameOrAdjacentSegment: item.segmentKey === event.segment_key,
    }));
    prior.push({
      candidate: true,
      vehicleId: event.vehicle_id,
      timestampMs: event.timestamp_ms,
      sameVehicleConsecutive: false,
      sameOrAdjacentSegment: true,
    });
    const confirmation = confirmPhase11Anomaly(anomaly, prior, cachedTraffic, { nowMs: now.getTime() });
    state.candidates ||= [];
    state.candidates.push({
      candidate: true,
      vehicleId: event.vehicle_id,
      segmentKey: event.segment_key,
      timestampMs: event.timestamp_ms,
    });
    await env.DB.prepare(`INSERT INTO anomalies
      (event_id, segment_key, vehicle_id, observed_at, actual_seconds, expected_seconds, delay_seconds, ratio, confirmed, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING`).bind(
      event.event_id, event.segment_key, event.vehicle_id, event.observed_at,
      event.seconds, expected, anomaly.delaySeconds, anomaly.ratio,
      confirmation.confirmed ? 1 : 0, confirmation.reason,
    ).run();
    if (confirmation.confirmed && !cachedTraffic) {
      await queryAndStoreTraffic(event, anomaly, env, now, fetchImpl);
    }
  }
}

async function queryAndStoreTraffic(event, anomaly, env, now, fetchImpl) {
  if (!env.TOMTOM_API_KEY || !Number.isFinite(event.latitude) || !Number.isFinite(event.longitude)) return null;
  if (!(await trafficQuotaAvailable(env.DB, env, now, anomaly.critical))) return null;
  const url = new URL("https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json");
  url.searchParams.set("point", `${event.latitude},${event.longitude}`);
  url.searchParams.set("unit", "KMPH");
  url.searchParams.set("key", env.TOMTOM_API_KEY);
  const response = await fetchWithTimeout(url.toString(), Number(env.TRAFFIC_TIMEOUT_MS || 5000), fetchImpl);
  await recordTrafficUsage(env.DB, now, response.ok);
  if (!response.ok) return null;
  const data = await response.json();
  const flow = data.flowSegmentData || {};
  const trafficRatio = Number(flow.currentTravelTime) > 0 && Number(flow.freeFlowTravelTime) > 0
    ? Number(flow.currentTravelTime) / Number(flow.freeFlowTravelTime)
    : Number(flow.currentSpeed) > 0 ? Number(flow.freeFlowSpeed) / Number(flow.currentSpeed) : 1;
  const normalized = {
    segment_key: event.segment_key,
    provider: "tomtom",
    observed_at: now.toISOString(),
    expires_at_ms: now.getTime() + Number(env.TRAFFIC_CACHE_SECONDS || 600) * 1000,
    current_travel_seconds: Number(flow.currentTravelTime) || null,
    freeflow_travel_seconds: Number(flow.freeFlowTravelTime) || null,
    traffic_ratio: trafficRatio,
    confidence: Number(flow.confidence) || 0,
    road_closed: Boolean(flow.roadClosure),
    incident: false,
  };
  const correctionRatio = buildCorrectionRatio(normalized, anomaly.ratio);
  await env.DB.prepare(`INSERT INTO corrections
    (segment_key, provider, correction_ratio, traffic_ratio, confidence, road_closed, incident, observed_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(segment_key) DO UPDATE SET provider=excluded.provider, correction_ratio=excluded.correction_ratio,
    traffic_ratio=excluded.traffic_ratio, confidence=excluded.confidence, road_closed=excluded.road_closed,
    incident=excluded.incident, observed_at=excluded.observed_at, expires_at=excluded.expires_at`).bind(
    event.segment_key, normalized.provider, correctionRatio, trafficRatio, normalized.confidence,
    normalized.road_closed ? 1 : 0, 0, normalized.observed_at, new Date(normalized.expires_at_ms).toISOString(),
  ).run();
  await writeTrafficCache(event.segment_key, normalized, env);
  return normalized;
}

async function handleEstimateBatch(request, env) {
  if (!env.DB) return jsonResponse({ estimates: [], fallback: "phase10", reason: "database-not-configured" }, 200, env);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid-json" }, 400, env); }
  const segments = Array.isArray(body.segments) ? body.segments.slice(0, 120) : [];
  if (!segments.length) return jsonResponse({ estimates: [] }, 200, env);
  const atMs = Number.isFinite(Date.parse(body.at)) ? Date.parse(body.at) : Date.now();
  const keys = [...new Set(segments.map((item) => item.segment_key).filter(Boolean))];
  const profiles = await readProfilesForSegments(env.DB, keys, atMs, holidaySet(env));
  const corrections = await readCorrectionsForSegments(env.DB, keys, atMs);
  const estimates = segments.map((segment) => ({
    segment_key: segment.segment_key,
    profile: profiles.get(segment.segment_key) || null,
    correction: corrections.get(segment.segment_key) || { active: false },
  })).filter((item) => item.profile || item.correction.active);
  return jsonResponse({ generated_at: new Date(atMs).toISOString(), estimates }, 200, env);
}

async function handleSingleEstimate(url, env, kind) {
  if (!env.DB) return jsonResponse({ active: false, fallback: "phase10" }, 200, env);
  const routeId = url.searchParams.get("route_id") || "";
  const directionId = url.searchParams.get("direction_id") || "";
  const fromStopId = url.searchParams.get("from_stop_id") || "";
  const toStopId = url.searchParams.get("to_stop_id") || "";
  if (!routeId || !fromStopId || !toStopId) return jsonResponse({ error: "missing-segment-parameters" }, 400, env);
  const key = phase11SegmentKey(routeId, directionId, fromStopId, toStopId);
  const atMs = Number.isFinite(Date.parse(url.searchParams.get("at"))) ? Date.parse(url.searchParams.get("at")) : Date.now();
  const map = kind === "profile"
    ? await readProfilesForSegments(env.DB, [key], atMs, holidaySet(env))
    : await readCorrectionsForSegments(env.DB, [key], atMs);
  return jsonResponse(map.get(key) || { active: false, segment_key: key }, 200, env);
}

async function readProfilesForSegments(db, keys, atMs, holidays = new Set()) {
  const result = new Map();
  if (!db || !keys.length) return result;
  const placeholders = keys.map(() => "?").join(",");
  const query = `SELECT * FROM profiles WHERE segment_key IN (${placeholders}) AND day_type = ? AND time_bin = ?`;
  const rows = await db.prepare(query).bind(...keys, phase11DayType(atMs, holidays), phase11TimeBin(atMs)).all();
  for (const row of rows.results || []) result.set(row.segment_key, row);
  return result;
}

async function readCorrectionsForSegments(db, keys, atMs) {
  const result = new Map();
  if (!db || !keys.length) return result;
  const placeholders = keys.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT * FROM corrections WHERE segment_key IN (${placeholders}) AND expires_at > ?`)
    .bind(...keys, new Date(atMs).toISOString()).all();
  for (const row of rows.results || []) result.set(row.segment_key, { ...row, active: true });
  return result;
}

async function compactPreviousHour(bucket, now) {
  const previous = new Date(now.getTime() - 60 * 60_000);
  const prefix = hourEventPrefix(previous);
  const hourlyKey = `hourly/${prefix.slice("events/".length).replace(/\/$/, ".json")}`;
  if (await bucket.head(hourlyKey)) return;
  const listed = await bucket.list({ prefix, limit: 120 });
  if (!listed.objects.length) return;
  const events = [];
  for (const object of listed.objects) {
    const payload = await readJsonObject(bucket, object.key, { events: [] });
    events.push(...(payload.events || []));
  }
  await bucket.put(hourlyKey, JSON.stringify({ generated_at: now.toISOString(), events }));
  await bucket.delete(listed.objects.map((item) => item.key));
}

async function aggregateProfiles(env, now) {
  const cutoff = now.getTime() - EVENT_RETENTION_DAYS * 86_400_000;
  const objects = await listAll(env.EVENT_BUCKET, "hourly/");
  const groups = new Map();
  const expired = [];
  const holidays = holidaySet(env);
  for (const object of objects) {
    if (object.uploaded && object.uploaded.getTime() < cutoff) { expired.push(object.key); continue; }
    const payload = await readJsonObject(env.EVENT_BUCKET, object.key, { events: [] });
    for (const event of payload.events || []) {
      if (Number(event.timestamp_ms) < cutoff || event.anomalous) continue;
      const groupKey = `${event.segment_key}|${phase11DayType(event.timestamp_ms, holidays)}|${phase11TimeBin(event.timestamp_ms)}`;
      const list = groups.get(groupKey) || [];
      list.push({ seconds: event.seconds, timestampMs: event.timestamp_ms, anomalous: false, event });
      groups.set(groupKey, list);
    }
  }
  const statements = [];
  for (const [groupKey, samples] of groups) {
    if (samples.length < 3) continue;
    const event = samples[0].event;
    const parts = groupKey.split("|");
    const timeBin = parts.pop();
    const dayType = parts.pop();
    const profile = buildWeeklyProfile(samples, percentileMedian(samples.map((item) => item.seconds)), now.getTime());
    if (!profile) continue;
    statements.push(env.DB.prepare(`INSERT INTO profiles
      (segment_key, route_id, direction_id, from_stop_id, to_stop_id, day_type, time_bin,
       profile_seconds, median_seconds, p25_seconds, p75_seconds, mad_seconds, sample_count, confidence, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(segment_key, day_type, time_bin) DO UPDATE SET
       profile_seconds=excluded.profile_seconds, median_seconds=excluded.median_seconds,
       p25_seconds=excluded.p25_seconds, p75_seconds=excluded.p75_seconds,
       mad_seconds=excluded.mad_seconds, sample_count=excluded.sample_count,
       confidence=excluded.confidence, generated_at=excluded.generated_at`).bind(
      event.segment_key, event.route_id, String(event.direction_id ?? ""), event.from_stop_id, event.to_stop_id,
      dayType, timeBin, profile.median_seconds, profile.median_seconds, profile.p25_seconds,
      profile.p75_seconds, profile.mad_seconds, profile.sample_count, profile.confidence, profile.generated_at,
    ));
  }
  for (let index = 0; index < statements.length; index += 50) await env.DB.batch(statements.slice(index, index + 50));
  if (expired.length) await env.EVENT_BUCKET.delete(expired.slice(0, 1000));
  return { profiles: statements.length };
}

async function proxyRealtime(request, env, ctx) {
  const cache = caches.default;
  const staleKey = new Request(new URL("/cached-feed", request.url), { method: "GET" });
  try {
    const response = await fetchWithTimeout(SOURCE, UPSTREAM_TIMEOUT_MS);
    if (!response.ok) throw new Error(`ODPT upstream HTTP ${response.status}`);
    const body = await response.arrayBuffer();
    if (!body.byteLength) throw new Error("ODPT upstream returned an empty feed");
    const headers = responseHeaders(response.headers, {
      "Cache-Control": "no-store", "X-Realtime-Source": "odpt-public", "X-Realtime-Stale": "false",
    }, env);
    const cachedHeaders = responseHeaders(response.headers, {
      "Cache-Control": `public, s-maxage=${STALE_CACHE_SECONDS}`,
      "X-Realtime-Source": "worker-cache", "X-Realtime-Stale": "true",
    }, env);
    ctx.waitUntil(cache.put(staleKey, new Response(body.slice(0), { status: 200, headers: cachedHeaders })));
    return new Response(body, { status: 200, headers });
  } catch (error) {
    const cached = await cache.match(staleKey);
    if (cached) return new Response(cached.body, { status: 200, headers: responseHeaders(cached.headers, {
      "Cache-Control": "no-store", "X-Realtime-Source": "worker-cache", "X-Realtime-Stale": "true",
      "X-Realtime-Upstream-Error": String(error.message || error).slice(0, 180),
    }, env) });
    return new Response(`Realtime upstream unavailable: ${error.message || error}`, {
      status: 502, headers: responseHeaders(null, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, env),
    });
  }
}

async function trafficQuotaAvailable(db, env, now, critical = false) {
  const month = now.toISOString().slice(0, 7);
  const row = await db.prepare("SELECT requests FROM traffic_usage WHERE month = ?").bind(month).first();
  const limit = Math.max(1, Number(env.TRAFFIC_MONTHLY_LIMIT || 20_000));
  const used = Number(row?.requests || 0);
  if (used >= limit * Number(env.TRAFFIC_STOP_RATIO || 0.95)) return false;
  if (!critical && used >= limit * Number(env.TRAFFIC_SOFT_RATIO || 0.80)) return false;
  return true;
}

async function recordTrafficUsage(db, now, success) {
  await db.prepare(`INSERT INTO traffic_usage (month, requests, successes, updated_at) VALUES (?, 1, ?, ?)
    ON CONFLICT(month) DO UPDATE SET requests=requests+1, successes=successes+excluded.successes, updated_at=excluded.updated_at`)
    .bind(now.toISOString().slice(0, 7), success ? 1 : 0, now.toISOString()).run();
}

async function readTrafficCache(segmentKey, env, nowMs) {
  if (typeof caches === "undefined") return null;
  const response = await caches.default.match(new Request(`https://phase11.invalid/traffic/${encodeURIComponent(segmentKey)}`));
  if (!response) return null;
  const value = await response.json();
  return Number(value.expires_at_ms) > nowMs ? value : null;
}

async function writeTrafficCache(segmentKey, value, env) {
  if (typeof caches === "undefined") return;
  const seconds = Number(env.TRAFFIC_CACHE_SECONDS || 600);
  await caches.default.put(
    new Request(`https://phase11.invalid/traffic/${encodeURIComponent(segmentKey)}`),
    new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${seconds}` } }),
  );
}

async function readJsonObject(bucket, key, fallback) {
  const object = await bucket.get(key);
  if (!object) return fallback;
  try { return await object.json(); } catch { return fallback; }
}

async function listAll(bucket, prefix) {
  const objects = [];
  let cursor;
  do {
    const result = await bucket.list({ prefix, cursor, limit: 1000 });
    objects.push(...result.objects);
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return objects;
}

function minuteEventKey(date) {
  return `${hourEventPrefix(date)}${String(date.getUTCMinutes()).padStart(2, "0")}-${date.getTime()}.json`;
}

function hourEventPrefix(date) {
  return `events/${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCHours()).padStart(2, "0")}/`;
}

function midpoint(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2 : Number.isFinite(b) ? b : Number.isFinite(a) ? a : null;
}

function tokyoClock(date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { hour: get("hour"), minute: get("minute") };
}

function holidaySet(env) {
  return new Set(String(env.HOLIDAY_DATE_KEYS || "").split(",").map((value) => value.trim()).filter(Boolean));
}

function percentileMedian(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function fetchWithTimeout(url, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { signal: controller.signal, cache: "no-store" }); }
  finally { clearTimeout(timer); }
}

function jsonResponse(value, status, env) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...corsHeaders(env), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function responseHeaders(baseHeaders, additions = {}, env = {}) {
  const headers = new Headers(baseHeaders || undefined);
  for (const [key, value] of Object.entries(corsHeaders(env))) headers.set(key, value);
  for (const [key, value] of Object.entries(additions)) headers.set(key, value);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/x-protobuf");
  return headers;
}

function corsHeaders(env = {}) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Expose-Headers": "X-Realtime-Source, X-Realtime-Stale, X-Realtime-Upstream-Error",
  };
}
