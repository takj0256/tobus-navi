import { haversineMeters } from "./geo.js";
import {
  findBestServiceDateForVehicle,
  findTripStopIndex,
  formatTimestampClock,
  minutesUntil,
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

    const estimate = estimateVehicleProgress(vehicle, trip, routeData, selection.stop_id, nowMs);
    if (!estimate || estimate.targetIndex < estimate.currentIndex) continue;
    results.push({ vehicle, trip, ...estimate });
  }

  return results.sort((a, b) => a.targetEtaMs - b.targetEtaMs || a.vehicle.entityId.localeCompare(b.vehicle.entityId));
}

export function estimateVehicleProgress(vehicle, trip, routeData, targetStopId, nowMs = Date.now()) {
  const stopTimes = trip?.stop_times || [];
  let currentIndex = findCurrentStopIndex(vehicle, trip, routeData);
  if (currentIndex < 0) return null;
  currentIndex = Math.min(currentIndex, stopTimes.length - 1);

  const targetIndices = stopTimes
    .map((stopTime, index) => stopTime[0] === targetStopId ? index : -1)
    .filter((index) => index >= 0);
  const targetIndex = targetIndices.find((index) => index >= currentIndex) ?? targetIndices[0] ?? -1;
  if (targetIndex < 0) return null;

  const vehicleTimestampMs = Number(vehicle.timestamp || Math.floor(nowMs / 1000)) * 1000;
  const serviceDate = findBestServiceDateForVehicle(
    trip,
    routeData,
    vehicleTimestampMs,
    vehicle.trip?.startDate || "",
  );

  const currentStopTime = stopTimes[currentIndex];
  const referenceSeconds = vehicle.currentStatus === 1 ? currentStopTime[2] : currentStopTime[1];
  const scheduledReferenceMs = scheduledTimestampMs(serviceDate, referenceSeconds);
  const delayMs = vehicleTimestampMs - scheduledReferenceMs;
  const targetScheduledMs = scheduledTimestampMs(serviceDate, stopTimes[targetIndex][1]);
  const targetEtaMs = Math.max(nowMs, targetScheduledMs + delayMs);

  return {
    serviceDate,
    currentIndex,
    targetIndex,
    delayMs,
    targetEtaMs,
    minutes: minutesUntil(targetEtaMs, nowMs),
    stopsAway: Math.max(0, targetIndex - currentIndex),
    currentLabel: vehicleLocationLabel(vehicle, trip, routeData, currentIndex),
    updatedAt: formatTimestampClock(vehicleTimestampMs),
  };
}

export function buildFutureStopEstimates(vehicle, trip, routeData, nowMs = Date.now(), limit = 15) {
  const currentIndex = findCurrentStopIndex(vehicle, trip, routeData);
  if (currentIndex < 0) return [];
  const vehicleTimestampMs = Number(vehicle.timestamp || Math.floor(nowMs / 1000)) * 1000;
  const serviceDate = findBestServiceDateForVehicle(trip, routeData, vehicleTimestampMs, vehicle.trip?.startDate || "");
  const currentStopTime = trip.stop_times[currentIndex];
  const referenceSeconds = vehicle.currentStatus === 1 ? currentStopTime[2] : currentStopTime[1];
  const delayMs = vehicleTimestampMs - scheduledTimestampMs(serviceDate, referenceSeconds);

  return trip.stop_times.slice(currentIndex, currentIndex + limit).map((stopTime, offset) => {
    const stop = routeData.stops[stopTime[0]] || { stop_name: stopTime[0], platform_code: "" };
    const etaMs = Math.max(nowMs, scheduledTimestampMs(serviceDate, stopTime[1]) + delayMs);
    return {
      stop_id: stopTime[0],
      stop_name: stop.stop_name,
      platform_code: stop.platform_code,
      stop_sequence: stopTime[3],
      index: currentIndex + offset,
      eta_ms: etaMs,
      minutes: minutesUntil(etaMs, nowMs),
      isCurrent: offset === 0,
    };
  });
}

export function vehicleLocationLabel(vehicle, trip, routeData, currentIndex = findCurrentStopIndex(vehicle, trip, routeData)) {
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
