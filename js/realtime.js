import { haversineMeters } from "./geo.js";
import {
  applyWeeklyProfile,
  effectiveCorrectionRatio,
  effectiveWeatherRatio,
  phase11SegmentKey,
} from "./phase11.js";
import {
  findBestServiceDateForVehicle,
  formatTimestampClock,
  scheduledTimestampMs,
} from "./timetable.js";

const textDecoder = new TextDecoder("utf-8");
const STATUS_LABELS = {
  0: "接近中",
  1: "停車中",
  2: "走行中",
};

export class RealtimeFetchError extends Error {
  constructor(attempts) {
    const summary = attempts.map((item) => `${item.label}: ${item.message}`).join(" / ");
    super(`リアルタイム情報を取得できませんでした。${summary}`);
    this.name = "RealtimeFetchError";
    this.attempts = attempts;
  }
}

export async function fetchRealtimeVehicles(sources, options = {}) {
  const normalizedSources = normalizeSources(sources);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs || 10_000);
  const retries = Math.max(0, Number(options.retries ?? 0));
  const attempts = [];

  for (const source of normalizedSources) {
    for (let retry = 0; retry <= retries; retry += 1) {
      try {
        const response = await fetchWithTimeout(source.url, fetchImpl, timeoutMs);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (!buffer.byteLength) throw new Error("空のデータを受信しました");
        const feed = decodeGtfsRealtime(buffer);
        feed.source = source;
        feed.receivedAt = Math.floor(Date.now() / 1000);
        feed.contentType = response.headers?.get?.("content-type") || "";
        return feed;
      } catch (error) {
        attempts.push({
          id: source.id,
          label: source.label,
          url: source.url,
          retry,
          message: friendlyFetchMessage(error, timeoutMs),
        });
      }
    }
  }

  throw new RealtimeFetchError(attempts);
}

export function realtimeFeedAgeMs(feed, nowMs = Date.now()) {
  const timestamp = Number(feed?.timestamp || feed?.receivedAt || 0);
  if (!timestamp) return Infinity;
  return Math.max(0, nowMs - timestamp * 1000);
}

export function isRealtimeFeedStale(feed, nowMs = Date.now(), staleAfterMs = 90_000) {
  return realtimeFeedAgeMs(feed, nowMs) > staleAfterMs;
}

async function fetchWithTimeout(url, fetchImpl, timeoutMs) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      const error = new Error(`timeout:${timeoutMs}`);
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetchImpl(url, {
        cache: "no-store",
        signal: controller?.signal,
        headers: { Accept: "application/x-protobuf, application/octet-stream" },
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSources(sources) {
  const list = Array.isArray(sources) ? sources : [sources];
  return list
    .map((source, index) => typeof source === "string"
      ? { id: `source-${index + 1}`, label: `取得先${index + 1}`, url: source }
      : source)
    .filter((source) => source?.url)
    .map((source, index) => ({
      id: source.id || `source-${index + 1}`,
      label: source.label || `取得先${index + 1}`,
      url: source.url,
    }));
}

function friendlyFetchMessage(error, timeoutMs) {
  if (error?.name === "TimeoutError" || String(error?.message || "").startsWith("timeout:")) {
    return `${Math.round(timeoutMs / 1000)}秒でタイムアウト`;
  }
  if (error?.name === "AbortError") return "通信が中断されました";
  if (/Failed to fetch|NetworkError|Load failed/i.test(String(error?.message || ""))) {
    return "ネットワークまたはCORSエラー";
  }
  return error?.message || "不明な通信エラー";
}

export function decodeGtfsRealtime(buffer) {
  const reader = new ProtoReader(new Uint8Array(buffer));
  const feed = { timestamp: 0, vehicles: [] };

  while (!reader.eof()) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) {
      const header = parseHeader(reader.readMessage());
      feed.timestamp = header.timestamp || 0;
    } else if (field === 2 && wire === 2) {
      const entity = parseEntity(reader.readMessage());
      if (entity.vehicle) feed.vehicles.push({ ...entity.vehicle, entityId: entity.id });
    } else {
      reader.skip(wire);
    }
  }

  for (const vehicle of feed.vehicles) {
    if (!vehicle.timestamp) vehicle.timestamp = feed.timestamp;
  }
  return feed;
}

export function getApproachingVehicles(routeData, selection, feed, nowMs = Date.now(), options = {}) {
  const maxVehicleAgeMs = Number(options.maxVehicleAgeMs ?? Infinity);
  const trips = new Map((routeData.trips || []).map((trip) => [trip.trip_id, trip]));
  const results = [];

  for (const vehicle of feed?.vehicles || []) {
    const vehicleTimestampMs = Number(vehicle.timestamp || 0) * 1000;
    if (Number.isFinite(maxVehicleAgeMs) && vehicleTimestampMs && nowMs - vehicleTimestampMs > maxVehicleAgeMs) continue;
    const trip = trips.get(vehicle.trip?.tripId);
    if (!trip) continue;
    if (selection.direction_id !== "" && selection.direction_id !== undefined) {
      if (String(trip.direction_id) !== String(selection.direction_id)) continue;
    }
    if (selection.headsign && trip.headsign !== selection.headsign) continue;

    const estimate = estimateVehicleProgress(vehicle, trip, routeData, selection.stop_id, nowMs, options);
    if (!estimate) continue;
    results.push({ vehicle, trip, ...estimate });
  }

  return results.sort((a, b) => a.targetEtaMs - b.targetEtaMs || a.vehicle.entityId.localeCompare(b.vehicle.entityId));
}

export function estimateVehicleProgress(vehicle, trip, routeData, targetStopId, nowMs = Date.now(), options = {}) {
  const stopTimes = trip?.stop_times || [];
  if (!stopTimes.length) return null;

  const vehicleTimestampMs = Number(vehicle.timestamp || Math.floor(nowMs / 1000)) * 1000;
  const serviceDate = findBestServiceDateForVehicle(
    trip,
    routeData,
    vehicleTimestampMs,
    vehicle.trip?.startDate || "",
  );
  const model = buildMotionModel(vehicle, trip, routeData, serviceDate, nowMs, options);
  if (!model) return null;

  const firstReachableIndex = model.isStopped ? model.currentIndex : model.nextIndex;
  const targetIndices = stopTimes
    .map((stopTime, index) => stopTime[0] === targetStopId ? index : -1)
    .filter((index) => index >= firstReachableIndex);
  const targetIndex = targetIndices[0] ?? -1;
  if (targetIndex < 0) return null;

  const secondsToTarget = travelSecondsFromModelToStop(model, stopTimes, targetIndex);
  if (!Number.isFinite(secondsToTarget)) return null;
  const targetEtaMs = nowMs + secondsToTarget * 1000;
  const range = buildEtaRange(targetEtaMs, nowMs, model, Math.max(0, targetIndex - firstReachableIndex));

  return {
    serviceDate,
    currentIndex: model.currentIndex,
    nextIndex: model.nextIndex,
    previousIndex: model.previousIndex,
    targetIndex,
    delayMs: model.delayMs,
    targetEtaMs,
    etaMinMs: range.minMs,
    etaMaxMs: range.maxMs,
    etaLabel: formatEtaRange(range.minMs, range.maxMs, nowMs),
    minutes: roundedMinutesUntil(targetEtaMs, nowMs),
    minutesMin: roundedMinutesUntil(range.minMs, nowMs),
    minutesMax: roundedMinutesUntil(range.maxMs, nowMs),
    stopsAway: Math.max(0, targetIndex - model.nextIndex),
    currentLabel: vehicleLocationLabel(vehicle, trip, routeData, model),
    updatedAt: formatTimestampClock(vehicleTimestampMs),
    feedAgeSeconds: model.feedAgeSeconds,
    anticipationSeconds: model.anticipationSeconds,
    segmentDurationSeconds: model.segmentDurationSeconds,
    segmentProgress: model.segmentProgress,
    observedProgress: model.observedProgress,
    positionSource: model.positionSource,
    trafficLabel: model.trafficLabel,
    trafficRatio: model.trafficRatio,
    trafficSampleCount: model.trafficSampleCount,
    correctionLabel: buildCorrectionLabel(model),
  };
}

export function buildFutureStopEstimates(vehicle, trip, routeData, nowMs = Date.now(), limit = 15, options = {}) {
  const stopTimes = trip?.stop_times || [];
  if (!stopTimes.length) return [];
  const vehicleTimestampMs = Number(vehicle.timestamp || Math.floor(nowMs / 1000)) * 1000;
  const serviceDate = findBestServiceDateForVehicle(trip, routeData, vehicleTimestampMs, vehicle.trip?.startDate || "");
  const model = buildMotionModel(vehicle, trip, routeData, serviceDate, nowMs, options);
  if (!model) return [];

  const firstIndex = model.isStopped ? model.currentIndex : model.nextIndex;
  let lastEtaMs = nowMs - 1;
  return stopTimes.slice(firstIndex, firstIndex + limit).map((stopTime, offset) => {
    const index = firstIndex + offset;
    const stop = routeData.stops[stopTime[0]] || { stop_name: stopTime[0], platform_code: "" };
    const secondsToStop = travelSecondsFromModelToStop(model, stopTimes, index);
    let etaMs = nowMs + Math.max(0, secondsToStop) * 1000;
    // GTFSの同一時刻や欠損があっても、後続停留所の到着が逆転しないようにする。
    if (offset > 0 && etaMs <= lastEtaMs) etaMs = lastEtaMs + 15_000;
    lastEtaMs = etaMs;
    const range = buildEtaRange(etaMs, nowMs, model, offset);
    const isCurrentStop = model.isStopped && index === model.currentIndex;
    return {
      stop_id: stopTime[0],
      stop_name: stop.stop_name,
      platform_code: stop.platform_code,
      stop_sequence: stopTime[3],
      index,
      eta_ms: etaMs,
      eta_min_ms: range.minMs,
      eta_max_ms: range.maxMs,
      eta_label: isCurrentStop ? "現在停車中" : formatEtaRange(range.minMs, range.maxMs, nowMs),
      minutes: roundedMinutesUntil(etaMs, nowMs),
      isCurrent: isCurrentStop,
    };
  });
}

export function buildMotionModel(vehicle, trip, routeData, serviceDate, nowMs = Date.now(), options = {}) {
  const stopTimes = trip?.stop_times || [];
  const anchorIndex = findCurrentStopIndex(vehicle, trip, routeData);
  if (anchorIndex < 0 || !stopTimes.length) return null;

  const safeAnchorIndex = Math.min(anchorIndex, stopTimes.length - 1);
  const vehicleTimestampMs = Number(vehicle.timestamp || Math.floor(nowMs / 1000)) * 1000;
  const feedAgeSeconds = Math.max(0, (nowMs - vehicleTimestampMs) / 1000);
  const fallbackSegmentSeconds = routeMedianSegmentSeconds(stopTimes);
  const routeScope = realtimeRouteScope(vehicle, trip);
  const historyOptions = {
    recentWindowMs: options.trafficRecentWindowMs,
    maximumAgeMs: options.trafficMaximumAgeMs,
    phase11Estimates: options.phase11Estimates,
    directionId: vehicle?.trip?.directionId ?? trip?.direction_id ?? "",
  };

  // 都営バス公開フィードの座標は停留所座標と一致するため、生GPSとして投影しない。
  // current_statusが明示されたSTOPPED_ATだけを停車とし、それ以外は報告済み停留所から
  // 次停留所へ進んでいる停留所イベントとして扱う。
  if ((vehicle.hasCurrentStatus && Number(vehicle.currentStatus) === 1) || safeAnchorIndex >= stopTimes.length - 1) {
    const referenceSeconds = stopTimes[safeAnchorIndex]?.[1] ?? stopTimes[safeAnchorIndex]?.[2] ?? 0;
    return {
      isStopped: true,
      currentIndex: safeAnchorIndex,
      nextIndex: safeAnchorIndex,
      previousIndex: safeAnchorIndex,
      segmentDurationSeconds: 0,
      scheduledSegmentSeconds: 0,
      observedProgress: 1,
      segmentProgress: 1,
      remainingSegmentSeconds: 0,
      feedAgeSeconds,
      anticipationSeconds: 0,
      positionSource: "explicit-stop-event",
      delayMs: vehicleTimestampMs - scheduledTimestampMs(serviceDate, referenceSeconds),
      uncertaintySeconds: Math.min(70, 25 + feedAgeSeconds * 0.25),
      speedFactor: 1,
      progressRate: 0,
      routeScope,
      segmentTravelHistory: options.segmentTravelHistory,
      trafficOptions: historyOptions,
      trafficLabel: "停車中",
      trafficRatio: 1,
      trafficSampleCount: 0,
      trafficSource: "stop-event",
      progressCapped: false,
      modelNowMs: nowMs,
    };
  }

  const previousIndex = safeAnchorIndex;
  const nextIndex = safeAnchorIndex + 1;
  const scheduledDuration = segmentDurationSeconds(stopTimes, previousIndex, fallbackSegmentSeconds);
  const traffic = estimateSegmentTravelTime(
    options.segmentTravelHistory,
    routeScope,
    stopTimes[previousIndex][0],
    stopTimes[nextIndex][0],
    scheduledDuration,
    nowMs,
    historyOptions,
  );
  const progressCap = clamp(Number(options.inferredProgressMaximum ?? 0.94), 0.5, 0.99);
  const rawProgress = feedAgeSeconds / Math.max(15, traffic.seconds);
  const segmentProgress = clamp(rawProgress, 0, progressCap);
  const progressCapped = rawProgress >= progressCap;
  const remainingSegmentSeconds = Math.max(
    progressCapped ? Math.min(30, traffic.seconds * (1 - progressCap)) : 0,
    (1 - segmentProgress) * traffic.seconds,
  );
  const scheduledNextArrivalMs = scheduledTimestampMs(serviceDate, stopTimes[nextIndex]?.[1] ?? 0);

  return {
    isStopped: false,
    currentIndex: previousIndex,
    nextIndex,
    previousIndex,
    segmentDurationSeconds: traffic.seconds,
    scheduledSegmentSeconds: scheduledDuration,
    observedProgress: 0,
    segmentProgress,
    remainingSegmentSeconds,
    feedAgeSeconds,
    anticipationSeconds: 0,
    positionSource: "stop-event-inferred",
    speedFactor: scheduledDuration / Math.max(1, traffic.seconds),
    progressRate: 1 / Math.max(1, traffic.seconds),
    delayMs: nowMs + remainingSegmentSeconds * 1000 - scheduledNextArrivalMs,
    uncertaintySeconds: calculateUncertaintySeconds({
      feedAgeSeconds,
      segmentDurationSeconds: traffic.seconds,
      sampleCount: traffic.sampleCount,
      progressCapped,
    }),
    routeScope,
    segmentTravelHistory: options.segmentTravelHistory,
    trafficOptions: historyOptions,
    trafficLabel: traffic.label,
    trafficRatio: traffic.ratio,
    trafficSampleCount: traffic.sampleCount,
    trafficSource: traffic.source,
    progressCapped,
    modelNowMs: nowMs,
  };
}

export function recordVehicleObservations(history, feed, maxEntries = 12) {
  if (!(history instanceof Map)) return history;
  for (const vehicle of feed?.vehicles || []) {
    const key = vehicleObservationKey(vehicle);
    if (!key) continue;
    const timestampMs = Number(vehicle.timestamp || feed.timestamp || 0) * 1000;
    if (!timestampMs) continue;
    const list = history.get(key) || [];
    if (list.some((item) => item.timestampMs === timestampMs)) continue;
    list.push({
      timestampMs,
      currentStopSequence: vehicle.currentStopSequence,
      currentStatus: vehicle.currentStatus,
      hasCurrentStatus: Boolean(vehicle.hasCurrentStatus),
      stopId: vehicle.stopId,
      tripId: vehicle.trip?.tripId || "",
      routeId: vehicle.trip?.routeId || "",
      directionId: vehicle.trip?.directionId ?? "",
      position: vehicle.position ? { ...vehicle.position } : null,
    });
    list.sort((a, b) => a.timestampMs - b.timestampMs);
    history.set(key, list.slice(-Math.max(2, maxEntries)));
  }
  return history;
}

export function recordSegmentTravelTimes(segmentHistory, vehicleHistory, feed, options = {}) {
  if (!(segmentHistory instanceof Map) || !(vehicleHistory instanceof Map)) return 0;
  const minimumSeconds = Math.max(5, Number(options.minimumSeconds ?? 15));
  const maximumSeconds = Math.max(minimumSeconds, Number(options.maximumSeconds ?? 30 * 60));
  const maxSamples = Math.max(3, Number(options.maxSamples ?? 48));
  let added = 0;

  for (const vehicle of feed?.vehicles || []) {
    const vehicleKey = vehicleObservationKey(vehicle);
    const observations = vehicleHistory.get(vehicleKey) || [];
    if (observations.length < 2) continue;
    const currentTimestampMs = Number(vehicle.timestamp || feed.timestamp || 0) * 1000;
    const currentIndex = observations.findIndex((item) => item.timestampMs === currentTimestampMs);
    if (currentIndex <= 0) continue;
    const current = observations[currentIndex];
    const previous = observations[currentIndex - 1];
    if (!current.stopId || !previous.stopId || current.stopId === previous.stopId) continue;
    if (current.tripId && previous.tripId && current.tripId !== previous.tripId) continue;
    if (Number.isFinite(Number(current.currentStopSequence)) && Number.isFinite(Number(previous.currentStopSequence))) {
      if (Number(current.currentStopSequence) - Number(previous.currentStopSequence) !== 1) continue;
    }
    const seconds = (current.timestampMs - previous.timestampMs) / 1000;
    if (!Number.isFinite(seconds) || seconds < minimumSeconds || seconds > maximumSeconds) continue;

    const routeScope = observationRouteScope(current);
    const key = segmentHistoryKey(routeScope, previous.stopId, current.stopId);
    const samples = segmentHistory.get(key) || [];
    const sampleId = `${vehicleKey}:${current.timestampMs}`;
    if (samples.some((sample) => sample.id === sampleId)) continue;
    samples.push({ id: sampleId, seconds, timestampMs: current.timestampMs });
    samples.sort((a, b) => a.timestampMs - b.timestampMs);
    segmentHistory.set(key, samples.slice(-maxSamples));
    added += 1;
  }
  return added;
}

export function serializeSegmentTravelHistory(segmentHistory, nowMs = Date.now(), maximumAgeMs = 14 * 86_400_000) {
  if (!(segmentHistory instanceof Map)) return [];
  const cutoff = nowMs - Math.max(60_000, Number(maximumAgeMs) || 0);
  return [...segmentHistory.entries()].map(([key, samples]) => [
    key,
    (samples || []).filter((sample) => Number(sample.timestampMs) >= cutoff).slice(-48),
  ]).filter(([, samples]) => samples.length > 0).slice(-1000);
}

export function deserializeSegmentTravelHistory(value, nowMs = Date.now(), maximumAgeMs = 14 * 86_400_000) {
  const history = new Map();
  if (!Array.isArray(value)) return history;
  const cutoff = nowMs - Math.max(60_000, Number(maximumAgeMs) || 0);
  for (const entry of value.slice(-1000)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Array.isArray(entry[1])) continue;
    const samples = entry[1].filter((sample) => (
      sample && typeof sample.id === "string"
      && Number.isFinite(Number(sample.seconds))
      && Number(sample.seconds) >= 5
      && Number(sample.timestampMs) >= cutoff
    )).map((sample) => ({
      id: sample.id,
      seconds: Number(sample.seconds),
      timestampMs: Number(sample.timestampMs),
    })).slice(-48);
    if (samples.length) history.set(entry[0], samples);
  }
  return history;
}

export function vehicleObservationKey(vehicle) {
  return vehicle?.vehicle?.id || vehicle?.entityId || vehicle?.trip?.tripId || "";
}

export function formatEtaRange(minMs, maxMs, nowMs = Date.now()) {
  const minSeconds = Math.max(0, Math.round((minMs - nowMs) / 1000));
  const maxSeconds = Math.max(0, Math.round((maxMs - nowMs) / 1000));
  if (maxSeconds < 45) return "まもなく";
  const minMinutes = Math.max(0, Math.round(minSeconds / 60));
  const maxMinutes = Math.max(minMinutes, Math.round(maxSeconds / 60));
  if (minMinutes === 0 && maxMinutes <= 1) return "約1分";
  if (minMinutes === maxMinutes) return `約${Math.max(1, minMinutes)}分`;
  return `約${Math.max(1, minMinutes)}〜${Math.max(1, maxMinutes)}分`;
}

function buildCorrectionLabel(model) {
  if (model.isStopped) return "停車イベントを基準に表示";
  const age = Math.round(model.feedAgeSeconds);
  const sampleText = model.trafficSource === "external-correction"
    ? `週間実績と周辺道路情報・${model.trafficLabel}`
    : model.trafficSource === "weekly-profile"
      ? `週間実績${model.trafficSampleCount}件・${model.trafficLabel}`
      : model.trafficSampleCount > 0
        ? `先行車${model.trafficSampleCount}件・${model.trafficLabel}`
        : "先行車実績なし・時刻表基準";
  const capText = model.progressCapped ? "・次停留所の更新待ち" : "";
  return `停留所更新から${age}秒・${sampleText}${capText}`;
}

function travelSecondsFromModelToStop(model, stopTimes, targetIndex) {
  if (model.isStopped) {
    if (targetIndex < model.currentIndex) return Infinity;
    if (targetIndex === model.currentIndex) return 0;
    let seconds = stopDwellSeconds(stopTimes, model.currentIndex);
    for (let index = model.currentIndex; index < targetIndex; index += 1) {
      seconds += modelSegmentDuration(model, stopTimes, index);
      if (index + 1 < targetIndex) seconds += stopDwellSeconds(stopTimes, index + 1);
    }
    return seconds;
  }

  if (targetIndex < model.nextIndex) return Infinity;
  let seconds = model.remainingSegmentSeconds;
  if (targetIndex === model.nextIndex) return seconds;
  const fallback = routeMedianSegmentSeconds(stopTimes);
  for (let index = model.nextIndex; index < targetIndex; index += 1) {
    seconds += stopDwellSeconds(stopTimes, index);
    seconds += modelSegmentDuration(model, stopTimes, index, fallback);
  }
  return seconds;
}

function modelSegmentDuration(model, stopTimes, previousIndex, fallback = routeMedianSegmentSeconds(stopTimes)) {
  const scheduled = segmentDurationSeconds(stopTimes, previousIndex, fallback);
  if (!model?.segmentTravelHistory || previousIndex + 1 >= stopTimes.length) return scheduled;
  return estimateSegmentTravelTime(
    model.segmentTravelHistory,
    model.routeScope,
    stopTimes[previousIndex][0],
    stopTimes[previousIndex + 1][0],
    scheduled,
    model.modelNowMs || Date.now(),
    model.trafficOptions,
  ).seconds;
}

function segmentDurationSeconds(stopTimes, previousIndex, fallbackSeconds = 60) {
  if (previousIndex < 0 || previousIndex + 1 >= stopTimes.length) return Math.max(15, fallbackSeconds);
  const departure = Number(stopTimes[previousIndex]?.[2]);
  const arrival = Number(stopTimes[previousIndex + 1]?.[1]);
  const duration = arrival - departure;
  if (Number.isFinite(duration) && duration > 0) return Math.max(10, duration);
  return Math.max(15, Number(fallbackSeconds) || 60);
}

function stopDwellSeconds(stopTimes, index) {
  const arrival = Number(stopTimes[index]?.[1]);
  const departure = Number(stopTimes[index]?.[2]);
  if (!Number.isFinite(arrival) || !Number.isFinite(departure)) return 0;
  return clamp(departure - arrival, 0, 180);
}

function routeMedianSegmentSeconds(stopTimes) {
  const values = [];
  for (let index = 0; index < stopTimes.length - 1; index += 1) {
    const value = Number(stopTimes[index + 1]?.[1]) - Number(stopTimes[index]?.[2]);
    if (Number.isFinite(value) && value >= 10 && value <= 3600) values.push(value);
  }
  if (!values.length) return 60;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

export function estimateSegmentTravelTime(
  segmentHistory,
  routeScope,
  previousStopId,
  nextStopId,
  scheduledSeconds,
  nowMs = Date.now(),
  options = {},
) {
  const scheduled = Math.max(15, Number(scheduledSeconds) || 60);
  const phase11Key = phase11SegmentKey(routeScope, options?.directionId ?? "", previousStopId, nextStopId);
  const phase11 = options?.phase11Estimates instanceof Map
    ? options.phase11Estimates.get(phase11Key)
    : options?.phase11Estimates?.[phase11Key];
  const weekly = applyWeeklyProfile(scheduled, phase11?.profile || phase11);
  const weatherRatio = effectiveWeatherRatio(phase11?.weather);
  const correction = phase11?.correction;
  const correctionRatio = correction?.active === false ? 1 : effectiveCorrectionRatio(
    correction?.correction_ratio ?? correction?.traffic_ratio ?? 1,
    Math.max(0, (nowMs - Date.parse(correction?.observed_at || correction?.updated_at || 0)) / 60_000),
    Number(correction?.downstream_segment_count || 0),
  );
  const phase11Baseline = weekly.seconds * weatherRatio * correctionRatio;
  const recentWindowMs = Math.max(60_000, Number(options?.recentWindowMs ?? 45 * 60_000));
  const maximumAgeMs = Math.max(recentWindowMs, Number(options?.maximumAgeMs ?? 14 * 86_400_000));
  const samples = segmentHistory instanceof Map
    ? segmentHistory.get(segmentHistoryKey(routeScope, previousStopId, nextStopId)) || []
    : [];
  const valid = samples.filter((sample) => (
    Number.isFinite(Number(sample.seconds))
    && Number(sample.seconds) >= 5
    && Number(sample.timestampMs) >= nowMs - maximumAgeMs
  ));
  const recent = valid.filter((sample) => Number(sample.timestampMs) >= nowMs - recentWindowMs);
  const candidates = recent.length >= 2 ? recent : sameTokyoHourSamples(valid, nowMs);
  const selected = (candidates.length ? candidates : valid).slice(-12);
  if (!selected.length) {
    const weatherActive = Math.abs(weatherRatio - 1) > 0.01;
    const phase11Active = weekly.source === "weekly-profile" || weatherActive || Math.abs(correctionRatio - 1) > 0.01;
    return {
      seconds: phase11Baseline,
      ratio: phase11Baseline / scheduled,
      label: phase11Active ? (Math.abs(correctionRatio - 1) > 0.01 ? "交通情報補正"
        : weatherActive ? "天候補正" : "週間実績") : "時刻表基準",
      sampleCount: Number(phase11?.profile?.sample_count ?? phase11?.sample_count ?? 0),
      phase11Active,
      source: Math.abs(correctionRatio - 1) > 0.01 ? "external-correction"
        : weatherActive ? "weather-profile"
        : weekly.source === "weekly-profile" ? "weekly-profile" : "schedule",
    };
  }

  const observed = robustMedian(selected.map((sample) => Number(sample.seconds)));
  const confidenceWeight = Math.min(0.75, 0.25 + selected.length * 0.1);
  const boundedObserved = clamp(observed, phase11Baseline * 0.5, phase11Baseline * 3);
  const seconds = phase11Baseline * (1 - confidenceWeight) + boundedObserved * confidenceWeight;
  const ratio = seconds / scheduled;
  return {
    seconds,
    ratio,
    label: trafficLabel(ratio),
    sampleCount: selected.length,
    phase11Active: weekly.source === "weekly-profile"
      || Math.abs(weatherRatio - 1) > 0.01 || Math.abs(correctionRatio - 1) > 0.01,
    source: "recent-history",
  };
}

function sameTokyoHourSamples(samples, nowMs) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo", hour: "2-digit", hourCycle: "h23",
  }).format(new Date(nowMs)));
  return samples.filter((sample) => {
    const sampleHour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo", hour: "2-digit", hourCycle: "h23",
    }).format(new Date(sample.timestampMs)));
    return Math.abs(sampleHour - hour) <= 1 || Math.abs(sampleHour - hour) >= 23;
  });
}

function robustMedian(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const trim = sorted.length >= 7 ? 1 : 0;
  const usable = sorted.slice(trim, sorted.length - trim);
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2;
}

function trafficLabel(ratio) {
  if (ratio >= 1.35) return "混雑傾向";
  if (ratio >= 1.12) return "やや遅め";
  if (ratio <= 0.88) return "順調";
  return "通常程度";
}

function realtimeRouteScope(vehicle, trip) {
  return vehicle?.trip?.routeId || vehicle?.trip?.tripId || trip?.shape_id || trip?.headsign || "route";
}

function observationRouteScope(observation) {
  return observation.routeId || observation.tripId || "route";
}

function segmentHistoryKey(routeScope, previousStopId, nextStopId) {
  return `${routeScope || "route"}|${previousStopId || "?"}>${nextStopId || "?"}`;
}

function calculateUncertaintySeconds({ feedAgeSeconds, segmentDurationSeconds, sampleCount, progressCapped }) {
  const base = 28
    + Math.min(55, feedAgeSeconds * 0.22)
    + Math.min(35, segmentDurationSeconds * 0.08)
    + (sampleCount >= 4 ? -12 : sampleCount > 0 ? -5 : 20)
    + (progressCapped ? 35 : 0);
  return clamp(base, 30, 150);
}

function buildEtaRange(etaMs, nowMs, model, stopOffset = 0) {
  const downstreamGrowth = Math.min(75, Math.max(0, stopOffset) * 5);
  const uncertaintyMs = (model.uncertaintySeconds + downstreamGrowth) * 1000;
  return {
    minMs: Math.max(nowMs, etaMs - uncertaintyMs),
    maxMs: Math.max(nowMs, etaMs + uncertaintyMs),
  };
}

function roundedMinutesUntil(timestampMs, nowMs = Date.now()) {
  return Math.max(0, Math.round((timestampMs - nowMs) / 60_000));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function vehicleLocationLabel(vehicle, trip, routeData, model = null) {
  if (model?.isStopped) {
    const stopTime = trip?.stop_times?.[model.currentIndex];
    const stop = stopTime ? routeData.stops?.[stopTime[0]] : null;
    return `${stop?.stop_name || vehicle.stopId || "停留所"}に停車中`;
  }
  if (model && Number.isFinite(model.previousIndex) && Number.isFinite(model.nextIndex)) {
    const previousStopTime = trip?.stop_times?.[model.previousIndex];
    const nextStopTime = trip?.stop_times?.[model.nextIndex];
    const previousName = previousStopTime ? routeData.stops?.[previousStopTime[0]]?.stop_name : "前停留所";
    const nextName = nextStopTime ? routeData.stops?.[nextStopTime[0]]?.stop_name : "次停留所";
    return `${previousName || "前停留所"}〜${nextName || "次停留所"}間（推定）`;
  }

  const currentIndex = findCurrentStopIndex(vehicle, trip, routeData);
  const stopTime = trip?.stop_times?.[currentIndex];
  const stop = stopTime ? routeData.stops?.[stopTime[0]] : null;
  const stopName = stop?.stop_name || vehicle.stopId || "次の停留所";
  if (vehicle.currentStatus === 1) return `${stopName}に停車中`;
  if (vehicle.currentStatus === 0) return `${stopName}に接近中`;
  return `${stopName}へ走行中`;
}

export function realtimeStatusLabel(status) {
  return STATUS_LABELS[status] || "位置取得中";
}

function findCurrentStopIndex(vehicle, trip, routeData) {
  const stopTimes = trip?.stop_times || [];
  if (Number.isFinite(vehicle.currentStopSequence)) {
    const exact = stopTimes.findIndex((stopTime) => Number(stopTime[3]) === Number(vehicle.currentStopSequence));
    if (exact >= 0) return exact;
  }
  if (vehicle.stopId) {
    const byStop = stopTimes.findIndex((stopTime) => stopTime[0] === vehicle.stopId);
    if (byStop >= 0) return byStop;
  }
  if (vehicle.position && Number.isFinite(vehicle.position.latitude) && Number.isFinite(vehicle.position.longitude)) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    stopTimes.forEach((stopTime, index) => {
      const stop = routeData.stops?.[stopTime[0]];
      if (!stop) return;
      const distance = haversineMeters(
        vehicle.position.latitude,
        vehicle.position.longitude,
        Number(stop.lat),
        Number(stop.lon),
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return bestIndex;
  }
  return -1;
}

function parseHeader(reader) {
  const header = { timestamp: 0 };
  while (!reader.eof()) {
    const { field, wire } = reader.readTag();
    if (field === 3 && wire === 0) header.timestamp = reader.readVarint();
    else reader.skip(wire);
  }
  return header;
}

function parseEntity(reader) {
  const entity = { id: "", vehicle: null };
  while (!reader.eof()) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) entity.id = reader.readString();
    else if (field === 4 && wire === 2) entity.vehicle = parseVehicle(reader.readMessage());
    else reader.skip(wire);
  }
  return entity;
}

function parseVehicle(reader) {
  const vehicle = {
    trip: {},
    position: null,
    currentStopSequence: null,
    currentStatus: 2,
    hasCurrentStatus: false,
    timestamp: 0,
    stopId: "",
    vehicle: {},
  };
  while (!reader.eof()) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) vehicle.trip = parseTripDescriptor(reader.readMessage());
    else if (field === 2 && wire === 2) vehicle.position = parsePosition(reader.readMessage());
    else if (field === 3 && wire === 0) vehicle.currentStopSequence = reader.readVarint();
    else if (field === 4 && wire === 0) {
      vehicle.currentStatus = reader.readVarint();
      vehicle.hasCurrentStatus = true;
    }
    else if (field === 5 && wire === 0) vehicle.timestamp = reader.readVarint();
    else if (field === 7 && wire === 2) vehicle.stopId = reader.readString();
    else if (field === 8 && wire === 2) vehicle.vehicle = parseVehicleDescriptor(reader.readMessage());
    else reader.skip(wire);
  }
  return vehicle;
}

function parseTripDescriptor(reader) {
  const trip = { tripId: "", routeId: "", startTime: "", startDate: "", directionId: null };
  while (!reader.eof()) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) trip.tripId = reader.readString();
    else if (field === 2 && wire === 2) trip.startTime = reader.readString();
    else if (field === 3 && wire === 2) trip.startDate = reader.readString();
    else if (field === 5 && wire === 2) trip.routeId = reader.readString();
    else if (field === 6 && wire === 0) trip.directionId = reader.readVarint();
    else reader.skip(wire);
  }
  return trip;
}

function parsePosition(reader) {
  const position = { latitude: NaN, longitude: NaN, bearing: NaN, speed: NaN };
  while (!reader.eof()) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 5) position.latitude = reader.readFloat32();
    else if (field === 2 && wire === 5) position.longitude = reader.readFloat32();
    else if (field === 3 && wire === 5) position.bearing = reader.readFloat32();
    else if (field === 5 && wire === 5) position.speed = reader.readFloat32();
    else reader.skip(wire);
  }
  return position;
}

function parseVehicleDescriptor(reader) {
  const descriptor = { id: "", label: "", licensePlate: "" };
  while (!reader.eof()) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) descriptor.id = reader.readString();
    else if (field === 2 && wire === 2) descriptor.label = reader.readString();
    else if (field === 3 && wire === 2) descriptor.licensePlate = reader.readString();
    else reader.skip(wire);
  }
  return descriptor;
}

class ProtoReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.position = 0;
  }

  eof() {
    return this.position >= this.bytes.length;
  }

  readTag() {
    const tag = this.readVarint();
    if (!tag) throw new Error("GTFS-RTのタグが不正です。");
    return { field: Math.floor(tag / 8), wire: tag % 8 };
  }

  readVarint() {
    let result = 0n;
    let shift = 0n;
    for (let count = 0; count < 10; count += 1) {
      if (this.eof()) throw new Error("GTFS-RTのvarintが途中で終了しました。");
      const byte = this.bytes[this.position++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return Number(result);
      shift += 7n;
    }
    throw new Error("GTFS-RTのvarintが長すぎます。");
  }

  readMessage() {
    const length = this.readVarint();
    const end = this.position + length;
    if (end > this.bytes.length) throw new Error("GTFS-RTメッセージ長が不正です。");
    const reader = new ProtoReader(this.bytes.subarray(this.position, end));
    this.position = end;
    return reader;
  }

  readString() {
    const length = this.readVarint();
    const end = this.position + length;
    if (end > this.bytes.length) throw new Error("GTFS-RT文字列長が不正です。");
    const value = textDecoder.decode(this.bytes.subarray(this.position, end));
    this.position = end;
    return value;
  }

  readFloat32() {
    if (this.position + 4 > this.bytes.length) throw new Error("GTFS-RT floatが途中で終了しました。");
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.position, 4);
    const value = view.getFloat32(0, true);
    this.position += 4;
    return value;
  }

  skip(wire) {
    if (wire === 0) this.readVarint();
    else if (wire === 1) this.position += 8;
    else if (wire === 2) {
      const length = this.readVarint();
      this.position += length;
    }
    else if (wire === 5) this.position += 4;
    else throw new Error(`未対応のProtocol Buffers wire typeです: ${wire}`);
    if (this.position > this.bytes.length) throw new Error("GTFS-RTフィールドが範囲外です。");
  }
}
