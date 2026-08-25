import { decodeGtfsRealtime } from "../js/realtime.js";
import {
  buildCorrectionRatio,
  buildWeatherAdjustmentProfile,
  buildWeeklyProfile,
  confirmPhase11Anomaly,
  detectPhase11Anomaly,
  phase11DayType,
  phase11SegmentKey,
  phase11TimeBin,
} from "../js/phase11.js";

const SOURCE = "https://api-public.odpt.org/api/v4/gtfs/realtime/ToeiBus";
const WEATHER_SOURCE = "https://api.open-meteo.com/v1/forecast";
const UPSTREAM_TIMEOUT_MS = 8_000;
const STALE_CACHE_SECONDS = 90;
const EVENT_RETENTION_DAYS = 28;
const STATE_KEY = "state/latest.json";
const ANOMALY_MINIMUM_SAMPLES = 8;
const ANOMALY_MINIMUM_CONFIDENCE = 0.65;
const TOKYO_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
});
const WEATHER_MAXIMUM_AGE_MS = 2 * 60 * 60_000;

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
    const now = new Date(controller.scheduledTime || Date.now());
    ctx.waitUntil(runScheduledCollection(env, now));
  },
};

export async function runScheduledCollection(env, now = new Date(), fetchImpl = fetch) {
  if (!env.EVENT_BUCKET) return { enabled: false, events: 0 };
  let events = [];
  let collectionError = null;
  try {
    const response = await fetchWithTimeout(SOURCE, UPSTREAM_TIMEOUT_MS, fetchImpl);
    if (!response.ok) throw new Error(`ODPT upstream HTTP ${response.status}`);
    const feed = decodeGtfsRealtime(await response.arrayBuffer());
    const state = await readJsonObject(env.EVENT_BUCKET, STATE_KEY, { vehicles: {}, candidates: [] });
    if (weatherRefreshDue(state, env, now)) {
      state.weather_attempted_at = now.toISOString();
      try {
        state.weather = await fetchCurrentWeather(env, now, fetchImpl);
        if (env.DB) await storeCurrentWeather(env.DB, state.weather);
      } catch (error) {
        state.weather_error = String(error?.message || error).slice(0, 180);
      }
    }
    events = collectSegmentEvents(feed, state, now.getTime());

    if (events.length) {
      if (env.DB) {
        try {
          await processAnomalies(events, state, env, now, fetchImpl);
          delete state.anomaly_error;
        } catch (error) {
          // D1異常判定が落ちても、生の区間イベント収集は止めない。
          state.anomaly_error = String(error?.message || error).slice(0, 180);
        }
      }
      const key = minuteEventKey(now);
      await env.EVENT_BUCKET.put(key, JSON.stringify({ generated_at: now.toISOString(), events }));
    }
    state.candidates = (state.candidates || []).filter((item) => Number(item.timestampMs) >= now.getTime() - 10 * 60_000).slice(-200);
    await env.EVENT_BUCKET.put(STATE_KEY, JSON.stringify(state));
  } catch (error) {
    collectionError = error;
  }

  // R2保守は収集やD1の一時障害から独立させる。失敗した時間も後続Cronで追いつける。
  const hourlyCompaction = await compactCompletedHours(env.EVENT_BUCKET, now, 8);
  const holidays = holidaySet(env);
  const legacyUpgrade = await upgradeOneLegacyDailyObject(env.EVENT_BUCKET, now, holidays);
  const dailyCompaction = legacyUpgrade.upgraded
    ? { compacted: false, remainingCompletedDays: 1 }
    : await compactOneCompletedTokyoDay(env.EVENT_BUCKET, now, holidays);
  if (hourlyCompaction.compacted || legacyUpgrade.upgraded || dailyCompaction.compacted) {
    console.log(JSON.stringify({
      phase11_maintenance: true,
      hourlyKey: hourlyCompaction.hourlyKey || null,
      remainingCompletedHours: hourlyCompaction.remainingCompletedHours,
      dailyDate: dailyCompaction.dateKey || legacyUpgrade.dateKey || null,
      remainingCompletedDays: dailyCompaction.remainingCompletedDays ?? legacyUpgrade.remainingLegacyDays,
    }));
  }
  if (collectionError) throw collectionError;
  return {
    enabled: true,
    events: events.length,
    remainingCompletedHours: hourlyCompaction.remainingCompletedHours,
    remainingLegacyDays: legacyUpgrade.remainingLegacyDays,
    remainingCompletedDays: dailyCompaction.remainingCompletedDays,
  };
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
      weather: weatherForEvent(state.weather, current.timestampMs),
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
    if (!profile
      || Number(profile.sample_count) < ANOMALY_MINIMUM_SAMPLES
      || Number(profile.confidence) < ANOMALY_MINIMUM_CONFIDENCE) continue;
    const expected = Number(profile.profile_seconds || profile.median_seconds);
    const anomaly = detectPhase11Anomaly(event.seconds, expected, profile);
    event.anomalous = anomaly.candidate;
    if (!anomaly.candidate) continue;

    const cachedTraffic = await readTrafficCache(event.segment_key, env, now.getTime());
    const prior = (state.candidates || []).map((item) => ({
      ...item,
      sameVehicleConsecutive: isSameVehicleConsecutive(item, event),
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
      fromStopId: event.from_stop_id,
      toStopId: event.to_stop_id,
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

export function isSameVehicleConsecutive(candidate, event) {
  return candidate?.vehicleId === event?.vehicle_id
    && candidate?.toStopId === event?.from_stop_id;
}

function weatherRefreshDue(state, env, now) {
  if (String(env.WEATHER_ENABLED ?? "true").toLowerCase() === "false") return false;
  const intervalMs = Math.max(15, Number(env.WEATHER_REFRESH_MINUTES || 15)) * 60_000;
  const fetchedAt = Date.parse(state?.weather?.fetched_at || "");
  const attemptedAt = Date.parse(state?.weather_attempted_at || "");
  const latest = Math.max(Number.isFinite(fetchedAt) ? fetchedAt : 0, Number.isFinite(attemptedAt) ? attemptedAt : 0);
  return !latest || now.getTime() - latest >= intervalMs;
}

export async function fetchCurrentWeather(env, now = new Date(), fetchImpl = fetch) {
  const url = new URL(WEATHER_SOURCE);
  url.searchParams.set("latitude", String(env.WEATHER_LATITUDE || "35.6895"));
  url.searchParams.set("longitude", String(env.WEATHER_LONGITUDE || "139.6917"));
  url.searchParams.set("current", [
    "temperature_2m", "apparent_temperature", "precipitation", "rain", "showers",
    "snowfall", "weather_code", "wind_speed_10m",
  ].join(","));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("forecast_days", "1");
  const response = await fetchWithTimeout(url.toString(), Number(env.WEATHER_TIMEOUT_MS || 5000), fetchImpl);
  if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
  const body = await response.json();
  const current = body.current || {};
  const temperature = Number(current.temperature_2m);
  if (!Number.isFinite(temperature)) throw new Error("Open-Meteo temperature missing");
  const snapshot = {
    provider: "open-meteo",
    fetched_at: now.toISOString(),
    source_time: String(current.time || now.toISOString()),
    latitude: Number(body.latitude),
    longitude: Number(body.longitude),
    temperature_c: temperature,
    apparent_temperature_c: finiteOrNull(current.apparent_temperature),
    precipitation_mm: finiteOrZero(current.precipitation),
    rain_mm: finiteOrZero(current.rain),
    showers_mm: finiteOrZero(current.showers),
    snowfall_cm: finiteOrZero(current.snowfall),
    weather_code: Number(current.weather_code) || 0,
    wind_speed_kmh: finiteOrNull(current.wind_speed_10m),
  };
  snapshot.weather_class = classifyWeather(snapshot);
  snapshot.temperature_band = classifyTemperature(temperature);
  return snapshot;
}

export function classifyWeather(weather) {
  const code = Number(weather?.weather_code) || 0;
  const precipitation = Number(weather?.precipitation_mm) || 0;
  const snowfall = Number(weather?.snowfall_cm) || 0;
  if (snowfall > 0 || (code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (precipitation >= 5 || [65, 67, 82].includes(code)) return "heavy-rain";
  if (precipitation >= 0.1 || (code >= 51 && code <= 67)
    || (code >= 80 && code <= 82) || code >= 95) return "rain";
  return "dry";
}

export function classifyTemperature(temperatureC) {
  const value = Number(temperatureC);
  if (!Number.isFinite(value)) return "unknown";
  if (value < 5) return "cold";
  if (value < 15) return "cool";
  if (value < 25) return "mild";
  if (value < 30) return "warm";
  return "hot";
}

function weatherForEvent(weather, timestampMs) {
  const fetchedAt = Date.parse(weather?.fetched_at || "");
  if (!Number.isFinite(fetchedAt) || Math.abs(Number(timestampMs) - fetchedAt) > WEATHER_MAXIMUM_AGE_MS) return null;
  return {
    weather_class: weather.weather_class,
    temperature_band: weather.temperature_band,
    temperature_c: weather.temperature_c,
    precipitation_mm: weather.precipitation_mm,
    weather_code: weather.weather_code,
  };
}

async function storeCurrentWeather(db, weather) {
  await db.prepare(`INSERT INTO weather_current
    (id, provider, observed_at, weather_class, temperature_band, temperature_c,
     apparent_temperature_c, precipitation_mm, snowfall_cm, weather_code, wind_speed_kmh)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, observed_at=excluded.observed_at,
    weather_class=excluded.weather_class, temperature_band=excluded.temperature_band,
    temperature_c=excluded.temperature_c, apparent_temperature_c=excluded.apparent_temperature_c,
    precipitation_mm=excluded.precipitation_mm, snowfall_cm=excluded.snowfall_cm,
    weather_code=excluded.weather_code, wind_speed_kmh=excluded.wind_speed_kmh`).bind(
    weather.provider, weather.fetched_at, weather.weather_class, weather.temperature_band,
    weather.temperature_c, weather.apparent_temperature_c, weather.precipitation_mm,
    weather.snowfall_cm, weather.weather_code, weather.wind_speed_kmh,
  ).run();
}

function finiteOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function finiteOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
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
  const weatherProfiles = await readWeatherProfilesForSegments(env.DB, segments, atMs);
  const estimates = segments.map((segment) => ({
    segment_key: segment.segment_key,
    profile: profiles.get(segment.segment_key) || null,
    correction: corrections.get(segment.segment_key) || { active: false },
    weather: weatherProfiles.get(segment.segment_key) || { active: false },
  })).filter((item) => item.profile || item.correction.active || item.weather.active);
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
  for (const chunk of chunkUniqueKeys(keys)) {
    const placeholders = chunk.map(() => "?").join(",");
    const query = `SELECT * FROM profiles WHERE segment_key IN (${placeholders}) AND day_type = ? AND time_bin = ?`;
    const rows = await db.prepare(query).bind(
      ...chunk, phase11DayType(atMs, holidays), phase11TimeBin(atMs),
    ).all();
    for (const row of rows.results || []) result.set(row.segment_key, row);
  }
  return result;
}

async function readCorrectionsForSegments(db, keys, atMs) {
  const result = new Map();
  if (!db || !keys.length) return result;
  for (const chunk of chunkUniqueKeys(keys)) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.prepare(`SELECT * FROM corrections WHERE segment_key IN (${placeholders}) AND expires_at > ?`)
      .bind(...chunk, new Date(atMs).toISOString()).all();
    for (const row of rows.results || []) result.set(row.segment_key, { ...row, active: true });
  }
  return result;
}

async function readWeatherProfilesForSegments(db, segments, atMs) {
  const result = new Map();
  if (!db || !segments.length) return result;
  const current = await db.prepare("SELECT * FROM weather_current WHERE id = 1").first();
  const observedAt = Date.parse(current?.observed_at || "");
  if (!Number.isFinite(observedAt) || Math.abs(atMs - observedAt) > WEATHER_MAXIMUM_AGE_MS) return result;
  const routes = [...new Set(segments.map((segment) => String(segment.route_id || "")).filter(Boolean))];
  const profiles = new Map();
  for (const chunk of chunkUniqueKeys(routes, 70)) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.prepare(`SELECT * FROM weather_profiles
      WHERE weather_class = ? AND temperature_band = ?
      AND (route_id = '*' OR route_id IN (${placeholders}))`).bind(
      current.weather_class, current.temperature_band, ...chunk,
    ).all();
    for (const row of rows.results || []) {
      profiles.set(`${row.route_id}|${row.direction_id}`, row);
    }
  }
  const global = profiles.get("*|");
  for (const segment of segments) {
    const routeProfile = profiles.get(`${String(segment.route_id || "")}|${String(segment.direction_id ?? "")}`);
    const profile = routeProfile || global;
    if (!profile) continue;
    result.set(segment.segment_key, {
      ...profile,
      active: true,
      fallback_scope: routeProfile ? null : "global",
      current_temperature_c: current.temperature_c,
      current_precipitation_mm: current.precipitation_mm,
      current_weather_code: current.weather_code,
      observed_at: current.observed_at,
    });
  }
  return result;
}

export function chunkUniqueKeys(keys, maximum = 75) {
  const unique = [...new Set((keys || []).filter(Boolean))];
  const chunks = [];
  for (let index = 0; index < unique.length; index += maximum) {
    chunks.push(unique.slice(index, index + maximum));
  }
  return chunks;
}

export async function compactOneCompletedHour(bucket, now) {
  return compactCompletedHours(bucket, now, 1);
}

async function compactCompletedHours(bucket, now, maximumHours) {
  const objects = await listAll(bucket, "events/");
  const currentPrefix = hourEventPrefix(now);
  const prefixes = [...new Set(objects.map((object) => eventObjectHourPrefix(object.key))
    .filter((prefix) => prefix && prefix < currentPrefix))].sort();
  if (!prefixes.length) return { compacted: false, remainingCompletedHours: 0 };

  const selectedPrefixes = prefixes.slice(0, Math.max(1, maximumHours));
  const hourlyKeys = [];
  let sourceObjectCount = 0;
  for (const prefix of selectedPrefixes) {
    const hourlyKey = `hourly/${prefix.slice("events/".length).replace(/\/$/, ".json")}`;
    const sourceObjects = objects.filter((object) => eventObjectHourPrefix(object.key) === prefix);
    const existing = await readJsonObject(bucket, hourlyKey, { events: [] });
    const events = [...(existing.events || []), ...await readEventsFromObjects(bucket, sourceObjects)];
    const uniqueEvents = [...new Map(events.map((event) => [event.event_id || JSON.stringify(event), event])).values()];
    await bucket.put(hourlyKey, JSON.stringify({ generated_at: now.toISOString(), events: uniqueEvents }));
    await bucket.delete(sourceObjects.map((item) => item.key));
    hourlyKeys.push(hourlyKey);
    sourceObjectCount += sourceObjects.length;
  }
  return {
    compacted: true,
    hourlyKey: hourlyKeys.at(-1),
    hourlyKeys,
    sourceObjects: sourceObjectCount,
    remainingCompletedHours: prefixes.length - selectedPrefixes.length,
  };
}

export async function compactOneCompletedTokyoDay(bucket, now, holidays = new Set()) {
  const hourlyObjects = await listAll(bucket, "hourly/");
  const today = tokyoDateKey(now.getTime());
  const completedDays = [...new Set(hourlyObjects
    .map((object) => hourlyObjectTokyoDate(object.key))
    .filter((dateKey) => dateKey && dateKey < today))].sort();
  if (!completedDays.length) return { compacted: false, remainingCompletedDays: 0 };

  const dateKey = completedDays[0];
  const sourceObjects = hourlyObjects.filter((object) => hourlyObjectTokyoDate(object.key) === dateKey);
  const dailyKey = `daily-v2/${dateKey}.json`;
  const existing = await readJsonObject(bucket, dailyKey, null);
  const includedSourceKeys = new Set(existing?.source_keys || []);
  const pendingObjects = sourceObjects.filter((object) => !includedSourceKeys.has(object.key));
  const events = await readEventsFromObjects(bucket, pendingObjects);
  if (!existing || pendingObjects.length) {
    await bucket.put(dailyKey, JSON.stringify({
      version: 2,
      generated_at: now.toISOString(),
      date_key: dateKey,
      source_keys: [...new Set([...(existing?.source_keys || []), ...sourceObjects.map((object) => object.key)])].sort(),
      groups: mergeCompactDailyGroups(existing?.groups || [], buildCompactDailyGroups(events, holidays)),
    }));
  }
  if (sourceObjects.length) await bucket.delete(sourceObjects.map((object) => object.key));
  return {
    compacted: true,
    dateKey,
    sourceObjects: sourceObjects.length,
    remainingCompletedDays: completedDays.length - 1,
  };
}

export function mergeCompactDailyGroups(existingGroups, addedGroups) {
  const groups = new Map();
  for (const group of [...(existingGroups || []), ...(addedGroups || [])]) {
    const key = `${group.segment_key}|${group.day_type}|${group.time_bin}`;
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { ...group, samples: [...(group.samples || [])] });
    } else {
      current.samples.push(...(group.samples || []));
    }
  }
  return [...groups.values()];
}

async function upgradeOneLegacyDailyObject(bucket, now, holidays = new Set()) {
  const legacyObjects = await listAll(bucket, "daily/");
  const compactObjects = await listAll(bucket, "daily-v2/");
  const compactDates = new Set(compactObjects.map((object) => dailyObjectDate(object.key)).filter(Boolean));
  const pending = legacyObjects
    .map((object) => ({ object, dateKey: dailyObjectDate(object.key) }))
    .filter((item) => item.dateKey && !compactDates.has(item.dateKey))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  if (!pending.length) return { upgraded: false, remainingLegacyDays: 0 };
  const { object, dateKey } = pending[0];
  const payload = await readJsonObject(bucket, object.key, { events: [] });
  await bucket.put(`daily-v2/${dateKey}.json`, JSON.stringify({
    version: 2,
    generated_at: now.toISOString(),
    date_key: dateKey,
    source_keys: payload.source_keys || [],
    groups: buildCompactDailyGroups(payload.events || [], holidays),
  }));
  await bucket.delete(object.key);
  return { upgraded: true, dateKey, remainingLegacyDays: pending.length - 1 };
}

export function buildCompactDailyGroups(events, holidays = new Set()) {
  const groups = new Map();
  for (const event of events || []) {
    if (event.anomalous || !Number.isFinite(Number(event.seconds)) || !Number.isFinite(Number(event.timestamp_ms))) continue;
    const dayType = phase11DayType(event.timestamp_ms, holidays);
    const timeBin = phase11TimeBin(event.timestamp_ms);
    const key = `${event.segment_key}|${dayType}|${timeBin}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        segment_key: event.segment_key,
        route_id: event.route_id,
        direction_id: event.direction_id,
        from_stop_id: event.from_stop_id,
        to_stop_id: event.to_stop_id,
        day_type: dayType,
        time_bin: timeBin,
        samples: [],
      };
      groups.set(key, group);
    }
    group.samples.push([
      Number(event.seconds), Number(event.timestamp_ms),
      event.weather?.weather_class || null,
      event.weather?.temperature_band || null,
      finiteOrNull(event.weather?.temperature_c),
    ]);
  }
  return [...groups.values()];
}

export async function aggregateProfiles(env, now) {
  const cutoff = now.getTime() - EVENT_RETENTION_DAYS * 86_400_000;
  const dailyObjects = await listAll(env.EVENT_BUCKET, "daily-v2/");
  const hourlyObjects = await listAll(env.EVENT_BUCKET, "hourly/");
  const dailyDates = new Set(dailyObjects.map((object) => dailyObjectDate(object.key)).filter(Boolean));
  const objects = [
    ...dailyObjects,
    ...hourlyObjects.filter((object) => !dailyDates.has(hourlyObjectTokyoDate(object.key))),
  ];
  const groups = new Map();
  const expired = [];
  const holidays = holidaySet(env);
  for (const object of objects) {
    const dailyDate = dailyObjectDate(object.key);
    if ((dailyDate && dailyDate < tokyoDateKey(cutoff))
      || (!dailyDate && object.uploaded && object.uploaded.getTime() < cutoff)) {
      expired.push(object.key);
      continue;
    }
    const payload = await readJsonObject(env.EVENT_BUCKET, object.key, { events: [] });
    for (const compact of payload.groups || []) {
      const groupKey = `${compact.segment_key}|${compact.day_type}|${compact.time_bin}`;
      const list = groups.get(groupKey) || [];
      for (const sample of compact.samples || []) {
        const seconds = Number(sample[0]);
        const timestampMs = Number(sample[1]);
        if (timestampMs < cutoff || !Number.isFinite(seconds)) continue;
        list.push({
          seconds, timestampMs, anomalous: false, event: compact,
          weatherClass: sample[2] || null,
          temperatureBand: sample[3] || null,
          temperatureC: finiteOrNull(sample[4]),
        });
      }
      groups.set(groupKey, list);
    }
    for (const event of payload.events || []) {
      if (Number(event.timestamp_ms) < cutoff || event.anomalous) continue;
      const groupKey = `${event.segment_key}|${phase11DayType(event.timestamp_ms, holidays)}|${phase11TimeBin(event.timestamp_ms)}`;
      const list = groups.get(groupKey) || [];
      list.push({
        seconds: event.seconds, timestampMs: event.timestamp_ms, anomalous: false, event,
        weatherClass: event.weather?.weather_class || null,
        temperatureBand: event.weather?.temperature_band || null,
        temperatureC: finiteOrNull(event.weather?.temperature_c),
      });
      groups.set(groupKey, list);
    }
  }
  const statements = [];
  const baseProfiles = new Map();
  for (const [groupKey, samples] of groups) {
    if (samples.length < 3) continue;
    const event = samples[0].event;
    const parts = groupKey.split("|");
    const timeBin = parts.pop();
    const dayType = parts.pop();
    const profile = buildWeeklyProfile(samples, percentileMedian(samples.map((item) => item.seconds)), now.getTime());
    if (!profile) continue;
    baseProfiles.set(groupKey, { profile, event });
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
  await env.DB.prepare("DELETE FROM profiles WHERE generated_at <> ?").bind(now.toISOString()).run();
  const weatherStatements = buildWeatherProfileStatements(env.DB, groups, baseProfiles, now);
  for (let index = 0; index < weatherStatements.length; index += 50) {
    await env.DB.batch(weatherStatements.slice(index, index + 50));
  }
  await env.DB.prepare("DELETE FROM weather_profiles WHERE generated_at <> ?").bind(now.toISOString()).run();
  if (expired.length) await env.EVENT_BUCKET.delete(expired.slice(0, 1000));
  return { profiles: statements.length, weatherProfiles: weatherStatements.length, sourceObjects: objects.length };
}

function buildWeatherProfileStatements(db, groups, baseProfiles, now) {
  const weatherGroups = new Map();
  const add = (key, metadata, value) => {
    let group = weatherGroups.get(key);
    if (!group) {
      group = { ...metadata, samples: [] };
      weatherGroups.set(key, group);
    }
    group.samples.push(value);
  };
  for (const [groupKey, samples] of groups) {
    const base = baseProfiles.get(groupKey);
    if (!base || !Number.isFinite(Number(base.profile?.median_seconds))) continue;
    const event = base.event;
    for (const sample of samples) {
      if (!sample.weatherClass || !sample.temperatureBand) continue;
      const value = { ratio: Number(sample.seconds) / Number(base.profile.median_seconds), timestampMs: sample.timestampMs };
      const metadata = {
        route_id: String(event.route_id || ""), direction_id: String(event.direction_id ?? ""),
        weather_class: sample.weatherClass, temperature_band: sample.temperatureBand,
      };
      add(`route|${metadata.route_id}|${metadata.direction_id}|${sample.weatherClass}|${sample.temperatureBand}`,
        { scope: "route", ...metadata }, value);
      add(`global|${sample.weatherClass}|${sample.temperatureBand}`,
        { ...metadata, scope: "global", route_id: "*", direction_id: "" }, value);
    }
  }
  const statements = [];
  for (const group of weatherGroups.values()) {
    const global = group.scope === "global";
    const profile = buildWeatherAdjustmentProfile(group.samples, now.getTime(), {
      minimumSamples: global ? 100 : 20,
      targetSamples: global ? 400 : 80,
    });
    if (!profile || profile.confidence < 0.6) continue;
    statements.push(db.prepare(`INSERT INTO weather_profiles
      (scope, route_id, direction_id, weather_class, temperature_band, adjustment_ratio,
       median_ratio, p25_ratio, p75_ratio, sample_count, confidence, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, route_id, direction_id, weather_class, temperature_band) DO UPDATE SET
       adjustment_ratio=excluded.adjustment_ratio, median_ratio=excluded.median_ratio,
       p25_ratio=excluded.p25_ratio, p75_ratio=excluded.p75_ratio,
       sample_count=excluded.sample_count, confidence=excluded.confidence,
       generated_at=excluded.generated_at`).bind(
      group.scope, group.route_id, group.direction_id, group.weather_class, group.temperature_band,
      profile.adjustment_ratio, profile.median_ratio, profile.p25_ratio, profile.p75_ratio,
      profile.sample_count, profile.confidence, profile.generated_at,
    ));
  }
  return statements;
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

async function readEventsFromObjects(bucket, objects, batchSize = 10) {
  const events = [];
  for (let index = 0; index < objects.length; index += batchSize) {
    const payloads = await Promise.all(objects.slice(index, index + batchSize)
      .map((object) => readJsonObject(bucket, object.key, { events: [] })));
    for (const payload of payloads) events.push(...(payload.events || []));
  }
  return events;
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

function eventObjectHourPrefix(key) {
  return /^(events\/\d{4}-\d{2}-\d{2}\/\d{2}\/)/.exec(key)?.[1] || null;
}

function midpoint(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2 : Number.isFinite(b) ? b : Number.isFinite(a) ? a : null;
}

function tokyoClock(date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { hour: get("hour"), minute: get("minute") };
}

function tokyoDateKey(timestampMs) {
  const parts = TOKYO_DATE_FORMATTER.formatToParts(new Date(timestampMs));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function hourlyObjectTokyoDate(key) {
  const match = /^hourly\/(\d{4})-(\d{2})-(\d{2})\/(\d{2})\.json$/.exec(key);
  if (!match) return null;
  const timestampMs = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:00:00Z`);
  return Number.isFinite(timestampMs) ? tokyoDateKey(timestampMs) : null;
}

function dailyObjectDate(key) {
  return /^daily(?:-v2)?\/(\d{4}-\d{2}-\d{2})\.json$/.exec(key)?.[1] || null;
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
