import { haversineMeters, projectPointToSegmentMeters } from "./geo.js";
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
  const status = Number(vehicle.currentStatus);
  const observed = resolveObservedPosition(vehicle, trip, routeData, safeAnchorIndex, options);

  if (observed.type === "stop") {
    const stopIndex = observed.currentIndex;
    const stoppedHoldSeconds = Math.max(0, Number(options.stoppedHoldSeconds ?? 25));
    const movableAgeSeconds = Math.max(0, feedAgeSeconds - stoppedHoldSeconds);
    if (movableAgeSeconds <= 0 || stopIndex >= stopTimes.length - 1) {
      const referenceSeconds = stopTimes[stopIndex]?.[1] ?? stopTimes[stopIndex]?.[2] ?? 0;
      return {
        isStopped: true,
        currentIndex: stopIndex,
        nextIndex: stopIndex,
        previousIndex: stopIndex,
        segmentDurationSeconds: 0,
        observedProgress: 1,
        segmentProgress: 1,
        remainingSegmentSeconds: 0,
        feedAgeSeconds,
        anticipationSeconds: 0,
        positionSource: observed.source,
        delayMs: vehicleTimestampMs - scheduledTimestampMs(serviceDate, referenceSeconds),
        uncertaintySeconds: Math.min(55, 18 + feedAgeSeconds * 0.2),
        snapDistanceMeters: observed.snapDistanceMeters ?? 0,
        speedFactor: 1,
        progressRate: 0,
      };
    }

    const firstDuration = segmentDurationSeconds(stopTimes, stopIndex, fallbackSegmentSeconds);
    const anticipationSeconds = boundedAnticipation(firstDuration, options);
    const advanced = advanceAlongSchedule(
      stopTimes,
      { type: "segment", previousIndex: stopIndex, nextIndex: stopIndex + 1, progress: 0 },
      movableAgeSeconds + anticipationSeconds,
      1,
      fallbackSegmentSeconds,
    );
    return finalizeMotionModel({
      advanced,
      observedProgress: 0,
      feedAgeSeconds,
      anticipationSeconds,
      positionSource: "stopped-extrapolated",
      stopTimes,
      serviceDate,
      nowMs,
      vehicleTimestampMs,
      fallbackSegmentSeconds,
      hasPosition: false,
      hasHistory: false,
      snapDistanceMeters: observed.snapDistanceMeters ?? 0,
      speedFactor: 1,
      observedPreviousIndex: stopIndex,
    });
  }

  const initialDuration = segmentDurationSeconds(stopTimes, observed.previousIndex, fallbackSegmentSeconds);
  const scheduledRate = 1 / initialDuration;
  const historyRate = estimateHistoryProgressRate(
    options.observationHistory,
    vehicle,
    routeData,
    stopTimes[observed.previousIndex][0],
    stopTimes[observed.nextIndex][0],
    scheduledRate,
  );
  const speedFactor = Number.isFinite(historyRate)
    ? clamp(historyRate / scheduledRate * 0.65 + 0.35, 0.35, 2.5)
    : 1;
  const anticipationSeconds = boundedAnticipation(initialDuration, options);
  const correctionSeconds = feedAgeSeconds + anticipationSeconds;
  const advanced = advanceAlongSchedule(
    stopTimes,
    observed,
    correctionSeconds,
    speedFactor,
    fallbackSegmentSeconds,
  );

  return finalizeMotionModel({
    advanced,
    observedProgress: observed.progress,
    feedAgeSeconds,
    anticipationSeconds,
    positionSource: observed.source,
    stopTimes,
    serviceDate,
    nowMs,
    vehicleTimestampMs,
    fallbackSegmentSeconds,
    hasPosition: observed.source.startsWith("gps"),
    hasHistory: Number.isFinite(historyRate),
    snapDistanceMeters: observed.snapDistanceMeters ?? 0,
    speedFactor,
    observedPreviousIndex: observed.previousIndex,
  });
}

function finalizeMotionModel({
  advanced,
  observedProgress,
  feedAgeSeconds,
  anticipationSeconds,
  positionSource,
  stopTimes,
  serviceDate,
  nowMs,
  fallbackSegmentSeconds,
  hasPosition,
  hasHistory,
  snapDistanceMeters,
  speedFactor,
  observedPreviousIndex,
}) {
  if (advanced.type === "stop") {
    const stopIndex = advanced.currentIndex;
    const scheduledArrivalMs = scheduledTimestampMs(serviceDate, stopTimes[stopIndex]?.[1] ?? 0);
    return {
      isStopped: true,
      currentIndex: stopIndex,
      nextIndex: stopIndex,
      previousIndex: stopIndex,
      segmentDurationSeconds: 0,
      observedProgress,
      segmentProgress: 1,
      remainingSegmentSeconds: 0,
      feedAgeSeconds,
      anticipationSeconds,
      positionSource,
      speedFactor,
      progressRate: 0,
      delayMs: nowMs - scheduledArrivalMs,
      uncertaintySeconds: calculateUncertaintySeconds({
        feedAgeSeconds,
        segmentDurationSeconds: 0,
        hasPosition,
        hasHistory,
      }),
      snapDistanceMeters,
      correctedSegments: Math.max(0, stopIndex - Number(observedPreviousIndex || 0)),
    };
  }

  const duration = segmentDurationSeconds(stopTimes, advanced.previousIndex, fallbackSegmentSeconds);
  const remainingSegmentSeconds = Math.max(0, (1 - advanced.progress) * duration / Math.max(0.1, speedFactor));
  const scheduledNextArrivalMs = scheduledTimestampMs(serviceDate, stopTimes[advanced.nextIndex]?.[1] ?? 0);
  return {
    isStopped: false,
    currentIndex: advanced.previousIndex,
    nextIndex: advanced.nextIndex,
    previousIndex: advanced.previousIndex,
    segmentDurationSeconds: duration,
    observedProgress,
    segmentProgress: advanced.progress,
    remainingSegmentSeconds,
    feedAgeSeconds,
    anticipationSeconds,
    positionSource,
    speedFactor,
    progressRate: speedFactor / Math.max(1, duration),
    delayMs: nowMs + remainingSegmentSeconds * 1000 - scheduledNextArrivalMs,
    uncertaintySeconds: calculateUncertaintySeconds({
      feedAgeSeconds,
      segmentDurationSeconds: duration,
      hasPosition,
      hasHistory,
    }),
    snapDistanceMeters,
    correctedSegments: Math.max(0, advanced.previousIndex - Number(observedPreviousIndex || 0)),
  };
}

export function recordVehicleObservations(history, feed, maxEntries = 6) {
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
      stopId: vehicle.stopId,
      position: vehicle.position ? { ...vehicle.position } : null,
    });
    list.sort((a, b) => a.timestampMs - b.timestampMs);
    history.set(key, list.slice(-Math.max(2, maxEntries)));
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
  if (model.positionSource === "stopped") return "停車中のため先読み補正なし";
  const age = Math.round(model.feedAgeSeconds);
  const anticipation = Math.round(model.anticipationSeconds);
  const gpsCorrection = model.positionSource === "gps-segment-corrected" ? "・GPSで走行区間を補正" : "";
  const advance = model.correctedSegments > 0 ? `・配信時刻から${model.correctedSegments}区間先へ進行補正` : "";
  return `配信遅延${age}秒＋先読み${anticipation}秒で補正${gpsCorrection}${advance}`;
}

function resolveObservedPosition(vehicle, trip, routeData, anchorIndex, options = {}) {
  const stopTimes = trip?.stop_times || [];
  const status = Number(vehicle.currentStatus);
  if (status === 1 || stopTimes.length < 2) {
    return { type: "stop", currentIndex: anchorIndex, source: "stopped", snapDistanceMeters: 0 };
  }

  const expectedPreviousIndex = Math.max(0, Math.min(stopTimes.length - 2, anchorIndex - 1));
  const gpsCandidate = locateGpsSegment(
    vehicle,
    routeData,
    stopTimes,
    expectedPreviousIndex,
    options,
  );
  if (gpsCandidate) return gpsCandidate;

  let progress = status === 0 ? 0.85 : 0.35;
  if (anchorIndex === 0) progress = 0;
  return {
    type: "segment",
    previousIndex: expectedPreviousIndex,
    nextIndex: expectedPreviousIndex + 1,
    progress,
    source: status === 0 ? "status-incoming" : "status-transit",
    snapDistanceMeters: Infinity,
  };
}

function locateGpsSegment(vehicle, routeData, stopTimes, expectedPreviousIndex, options = {}) {
  const position = vehicle?.position;
  if (!position || !Number.isFinite(Number(position.latitude)) || !Number.isFinite(Number(position.longitude))) return null;
  const searchBehind = Math.max(0, Number(options.segmentSearchBehind ?? 1));
  const searchAhead = Math.max(1, Number(options.segmentSearchAhead ?? 3));
  const maximumSnapDistance = Math.max(80, Number(options.maximumSegmentSnapMeters ?? 350));
  const first = Math.max(0, expectedPreviousIndex - searchBehind);
  const last = Math.min(stopTimes.length - 2, expectedPreviousIndex + searchAhead);
  let best = null;

  for (let previousIndex = first; previousIndex <= last; previousIndex += 1) {
    const nextIndex = previousIndex + 1;
    const previousStop = routeData.stops?.[stopTimes[previousIndex][0]];
    const nextStop = routeData.stops?.[stopTimes[nextIndex][0]];
    if (!previousStop || !nextStop) continue;
    const projection = projectPointToSegmentMeters(
      Number(position.latitude),
      Number(position.longitude),
      Number(previousStop.lat),
      Number(previousStop.lon),
      Number(nextStop.lat),
      Number(nextStop.lon),
    );
    if (!Number.isFinite(projection.fraction) || !Number.isFinite(projection.distanceMeters)) continue;

    const sequenceDelta = previousIndex - expectedPreviousIndex;
    const sequencePenalty = sequenceDelta < 0 ? Math.abs(sequenceDelta) * 90 : sequenceDelta * 18;
    const incomingPenalty = Number(vehicle.currentStatus) === 0 && previousIndex === expectedPreviousIndex
      ? Math.max(0, 0.72 - projection.fraction) * 80
      : 0;
    const score = projection.distanceMeters + sequencePenalty + incomingPenalty;
    if (!best || score < best.score) {
      best = {
        type: "segment",
        previousIndex,
        nextIndex,
        progress: projection.fraction,
        source: previousIndex === expectedPreviousIndex ? "gps" : "gps-segment-corrected",
        snapDistanceMeters: projection.distanceMeters,
        score,
      };
    }
  }

  if (!best || best.snapDistanceMeters > maximumSnapDistance) return null;
  if (Number(vehicle.currentStatus) === 0 && best.previousIndex === expectedPreviousIndex) {
    best.progress = Math.max(0.78, best.progress);
  }
  return best;
}

function advanceAlongSchedule(stopTimes, initial, elapsedSeconds, speedFactor, fallbackSegmentSeconds) {
  let remaining = Math.max(0, Number(elapsedSeconds) || 0);
  let previousIndex = initial.previousIndex;
  let nextIndex = initial.nextIndex;
  let progress = clamp(Number(initial.progress) || 0, 0, 1);
  const factor = Math.max(0.1, Number(speedFactor) || 1);

  while (previousIndex >= 0 && nextIndex < stopTimes.length) {
    const scheduledDuration = segmentDurationSeconds(stopTimes, previousIndex, fallbackSegmentSeconds);
    const adjustedDuration = scheduledDuration / factor;
    const segmentRemaining = Math.max(0, (1 - progress) * adjustedDuration);
    if (remaining < segmentRemaining) {
      progress = clamp(progress + remaining / adjustedDuration, 0, 0.995);
      return { type: "segment", previousIndex, nextIndex, progress };
    }

    remaining -= segmentRemaining;
    const arrivedIndex = nextIndex;
    if (arrivedIndex >= stopTimes.length - 1) {
      return { type: "stop", currentIndex: arrivedIndex };
    }

    const dwell = stopDwellSeconds(stopTimes, arrivedIndex);
    if (remaining < dwell) return { type: "stop", currentIndex: arrivedIndex };
    remaining -= dwell;
    previousIndex = arrivedIndex;
    nextIndex = arrivedIndex + 1;
    progress = 0;
  }

  return { type: "stop", currentIndex: Math.max(0, stopTimes.length - 1) };
}

function travelSecondsFromModelToStop(model, stopTimes, targetIndex) {
  if (model.isStopped) {
    if (targetIndex < model.currentIndex) return Infinity;
    if (targetIndex === model.currentIndex) return 0;
    let seconds = stopDwellSeconds(stopTimes, model.currentIndex);
    for (let index = model.currentIndex; index < targetIndex; index += 1) {
      seconds += segmentDurationSeconds(stopTimes, index, routeMedianSegmentSeconds(stopTimes));
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
    seconds += segmentDurationSeconds(stopTimes, index, fallback);
  }
  return seconds;
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

function boundedAnticipation(segmentSeconds, options) {
  const maximum = Math.max(0, Number(options.anticipationMaxSeconds ?? 30));
  const ratio = Math.max(0, Number(options.anticipationSegmentRatio ?? 0.25));
  return Math.min(maximum, Math.max(0, segmentSeconds * ratio));
}

function estimateHistoryProgressRate(history, vehicle, routeData, previousStopId, nextStopId, scheduledRate) {
  if (!(history instanceof Map)) return NaN;
  const observations = history.get(vehicleObservationKey(vehicle)) || [];
  const currentTimestampMs = Number(vehicle.timestamp || 0) * 1000;
  const previous = [...observations].reverse().find((item) => (
    item.timestampMs < currentTimestampMs
    && Number(item.currentStatus) !== 1
    && item.position
  ));
  if (!previous) return NaN;
  const current = observedSegmentProgress(vehicle, routeData, previousStopId, nextStopId).progress;
  const previousVehicle = { position: previous.position };
  const before = observedSegmentProgress(previousVehicle, routeData, previousStopId, nextStopId).progress;
  const deltaSeconds = (currentTimestampMs - previous.timestampMs) / 1000;
  if (!Number.isFinite(current) || !Number.isFinite(before) || deltaSeconds < 3) return NaN;
  const rate = (current - before) / deltaSeconds;
  if (!Number.isFinite(rate) || rate <= 0) return NaN;
  return clamp(rate, scheduledRate * 0.15, scheduledRate * 3);
}

function observedSegmentProgress(vehicle, routeData, previousStopId, nextStopId) {
  const position = vehicle?.position;
  const previousStop = routeData.stops?.[previousStopId];
  const nextStop = routeData.stops?.[nextStopId];
  if (!position || !previousStop || !nextStop) return { progress: NaN, source: "none" };
  const projection = projectPointToSegmentMeters(
    Number(position.latitude),
    Number(position.longitude),
    Number(previousStop.lat),
    Number(previousStop.lon),
    Number(nextStop.lat),
    Number(nextStop.lon),
  );
  return {
    progress: projection.fraction,
    source: Number.isFinite(projection.fraction) ? "gps" : "none",
  };
}

function calculateUncertaintySeconds({ feedAgeSeconds, segmentDurationSeconds, hasPosition, hasHistory }) {
  const base = 18
    + Math.min(45, feedAgeSeconds * 0.18)
    + Math.min(20, segmentDurationSeconds * 0.06)
    + (hasPosition ? 0 : 20)
    + (hasHistory ? -8 : 0);
  return clamp(base, 20, 90);
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
    return `${previousName || "前停留所"}〜${nextName || "次停留所"}間`;
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
    timestamp: 0,
    stopId: "",
    vehicle: {},
  };
  while (!reader.eof()) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) vehicle.trip = parseTripDescriptor(reader.readMessage());
    else if (field === 2 && wire === 2) vehicle.position = parsePosition(reader.readMessage());
    else if (field === 3 && wire === 0) vehicle.currentStopSequence = reader.readVarint();
    else if (field === 4 && wire === 0) vehicle.currentStatus = reader.readVarint();
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
