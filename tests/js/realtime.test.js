import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFutureStopEstimates,
  buildMotionModel,
  decodeGtfsRealtime,
  deserializeSegmentTravelHistory,
  estimateVehicleProgress,
  estimateSegmentTravelTime,
  fetchRealtimeVehicles,
  formatEtaRange,
  isRealtimeFeedStale,
  realtimeFeedAgeMs,
  recordSegmentTravelTimes,
  recordVehicleObservations,
  serializeSegmentTravelHistory,
} from "../../js/realtime.js";
import { scheduledTimestampMs } from "../../js/timetable.js";

function varint(value) {
  let n = BigInt(value);
  const bytes = [];
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return bytes;
}
function fieldVarint(field, value) { return [...varint(field * 8), ...varint(value)]; }
function fieldBytes(field, bytes) { return [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes]; }
function fieldString(field, value) { return fieldBytes(field, [...new TextEncoder().encode(value)]); }
function fieldMessage(field, bytes) { return fieldBytes(field, bytes); }
function fieldFloat(field, value) {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setFloat32(0, value, true);
  return [...varint(field * 8 + 5), ...new Uint8Array(buffer)];
}

function makeFeed() {
  const timestamp = Math.floor(scheduledTimestampMs("20260719", 10 * 3600 + 2 * 60) / 1000);
  const header = [...fieldString(1, "2.0"), ...fieldVarint(3, timestamp)];
  const trip = [...fieldString(1, "t1"), ...fieldString(3, "20260719"), ...fieldString(5, "r1")];
  const position = [...fieldFloat(1, 35.0), ...fieldFloat(2, 139.0)];
  const descriptor = [...fieldString(1, "vehicle-1"), ...fieldString(2, "A001")];
  const vehicle = [
    ...fieldMessage(1, trip),
    ...fieldMessage(2, position),
    ...fieldVarint(3, 1),
    ...fieldVarint(4, 1),
    ...fieldVarint(5, timestamp),
    ...fieldString(7, "s1"),
    ...fieldMessage(8, descriptor),
  ];
  const entity = [...fieldString(1, "e1"), ...fieldMessage(4, vehicle)];
  return new Uint8Array([...fieldMessage(1, header), ...fieldMessage(2, entity)]).buffer;
}

const routeData = {
  stops: {
    s1: { stop_name: "始発", lat: 35.0, lon: 139.0 },
    s2: { stop_name: "次停留所", lat: 35.01, lon: 139.01 },
  },
  services: { calendars: {}, exceptions: {} },
};
const trip = {
  trip_id: "t1",
  service_id: "svc",
  headsign: "終点",
  direction_id: "0",
  stop_times: [["s1", 36000, 36000, 1], ["s2", 36600, 36600, 2]],
};

test("GTFS-RT VehiclePositionをデコードする", () => {
  const feed = decodeGtfsRealtime(makeFeed());
  assert.equal(feed.vehicles.length, 1);
  assert.equal(feed.vehicles[0].trip.tripId, "t1");
  assert.equal(feed.vehicles[0].vehicle.label, "A001");
  assert.equal(feed.vehicles[0].currentStopSequence, 1);
  assert.equal(feed.vehicles[0].hasCurrentStatus, true);
});

test("車両の遅れを後続停留所へ反映する", () => {
  const feed = decodeGtfsRealtime(makeFeed());
  const nowMs = feed.timestamp * 1000;
  const estimate = estimateVehicleProgress(feed.vehicles[0], trip, routeData, "s2", nowMs);
  assert.equal(estimate.stopsAway, 1);
  assert.equal(estimate.minutes, 10);
});

test("選択車両の将来到着一覧を生成する", () => {
  const feed = decodeGtfsRealtime(makeFeed());
  const future = buildFutureStopEstimates(feed.vehicles[0], trip, routeData, feed.timestamp * 1000, 10);
  assert.equal(future.length, 2);
  assert.equal(future[0].stop_name, "始発");
  assert.equal(future[1].minutes, 10);
});


test("取得先を順番に試してフォールバックする", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("primary")) throw new TypeError("Failed to fetch");
    return new Response(makeFeed(), {
      status: 200,
      headers: { "content-type": "application/x-protobuf" },
    });
  };
  const feed = await fetchRealtimeVehicles([
    { id: "primary", label: "直接配信", url: "https://primary.example/feed" },
    { id: "proxy", label: "中継", url: "https://proxy.example/feed" },
  ], { fetchImpl, timeoutMs: 100, retries: 0 });
  assert.deepEqual(calls, ["https://primary.example/feed", "https://proxy.example/feed"]);
  assert.equal(feed.source.id, "proxy");
  assert.equal(feed.vehicles.length, 1);
});

test("応答しない取得先をタイムアウトして次へ進む", async () => {
  const fetchImpl = (url) => {
    if (url.includes("slow")) return new Promise(() => {});
    return Promise.resolve(new Response(makeFeed(), { status: 200 }));
  };
  const feed = await fetchRealtimeVehicles([
    { id: "slow", label: "遅い配信", url: "https://slow.example/feed" },
    { id: "backup", label: "予備", url: "https://backup.example/feed" },
  ], { fetchImpl, timeoutMs: 5, retries: 0 });
  assert.equal(feed.source.id, "backup");
});

test("フィードの経過時間と古さを判定する", () => {
  const nowMs = Date.parse("2026-07-19T00:02:00Z");
  const feed = { timestamp: Math.floor(Date.parse("2026-07-19T00:00:00Z") / 1000) };
  assert.equal(realtimeFeedAgeMs(feed, nowMs), 120000);
  assert.equal(isRealtimeFeedStale(feed, nowMs, 90000), true);
  assert.equal(isRealtimeFeedStale(feed, nowMs, 180000), false);
});


const movingRouteData = {
  stops: {
    p: { stop_name: "前停留所", lat: 35.0, lon: 139.0 },
    n: { stop_name: "次停留所", lat: 35.0, lon: 139.04 },
    t: { stop_name: "乗車停留所", lat: 35.0, lon: 139.08 },
  },
  services: {
    calendars: {
      svc: { start_date: "20260101", end_date: "20261231", weekdays: [1, 1, 1, 1, 1, 1, 1] },
    },
    exceptions: {},
  },
};
const movingTrip = {
  trip_id: "moving",
  service_id: "svc",
  headsign: "終点",
  direction_id: "0",
  stop_times: [
    ["p", 36000, 36000, 1],
    ["n", 36240, 36240, 2],
    ["t", 36540, 36540, 3],
  ],
};

function movingVehicle(timestampMs, longitude = 139.01, status = 2, overrides = {}) {
  return {
    entityId: "moving-entity",
    trip: { tripId: "moving", routeId: "r1", directionId: 0, startDate: "20260719" },
    currentStopSequence: 2,
    currentStatus: status,
    hasCurrentStatus: false,
    timestamp: Math.floor(timestampMs / 1000),
    stopId: "n",
    position: { latitude: 35.0, longitude },
    vehicle: { id: "moving-bus", label: "M1" },
    ...overrides,
  };
}

test("公開座標を生GPSとして投影せず停留所イベントから進行率を推定する", () => {
  const observationMs = scheduledTimestampMs("20260719", 36240);
  const nowMs = observationMs + 120_000;
  const vehicle = movingVehicle(observationMs, 139.08);
  const model = buildMotionModel(vehicle, movingTrip, movingRouteData, "20260719", nowMs);
  assert.equal(model.previousIndex, 1);
  assert.equal(model.nextIndex, 2);
  assert.equal(model.positionSource, "stop-event-inferred");
  assert.ok(model.segmentProgress > 0.39 && model.segmentProgress < 0.41);
});

test("明示されたSTOPPED_ATだけを停車として扱う", () => {
  const observationMs = scheduledTimestampMs("20260719", 36240);
  const vehicle = movingVehicle(observationMs, 139.04, 1, { hasCurrentStatus: true });
  const model = buildMotionModel(vehicle, movingTrip, movingRouteData, "20260719", observationMs + 20_000);
  assert.equal(model.isStopped, true);
  assert.equal(model.anticipationSeconds, 0);
  assert.equal(model.segmentProgress, 1);
});

test("停留所の切替時刻から区間所要時間を学習する", () => {
  const vehicleHistory = new Map();
  const segmentHistory = new Map();
  const firstMs = scheduledTimestampMs("20260719", 36000);
  const first = movingVehicle(firstMs, 139.0, 2, { currentStopSequence: 1, stopId: "p" });
  const second = movingVehicle(firstMs + 420_000, 139.04, 2, { currentStopSequence: 2, stopId: "n" });
  recordVehicleObservations(vehicleHistory, { vehicles: [first] });
  recordVehicleObservations(vehicleHistory, { vehicles: [second] });
  assert.equal(recordSegmentTravelTimes(segmentHistory, vehicleHistory, { vehicles: [second] }), 1);
  assert.equal(segmentHistory.get("r1|p>n")[0].seconds, 420);
  assert.equal(recordSegmentTravelTimes(segmentHistory, vehicleHistory, { vehicles: [second] }), 0);
  const timestampOnly = movingVehicle(firstMs + 440_000, 139.04, 2, { currentStopSequence: 2, stopId: "n" });
  recordVehicleObservations(vehicleHistory, { vehicles: [timestampOnly] });
  assert.equal(recordSegmentTravelTimes(segmentHistory, vehicleHistory, { vehicles: [timestampOnly] }), 0);
});

test("先行車の遅い実績を現在区間の進行率と到着予測へ反映する", () => {
  const observationMs = scheduledTimestampMs("20260719", 36240);
  const nowMs = observationMs + 120_000;
  const history = new Map([["r1|n>t", [
    { id: "a", seconds: 600, timestampMs: nowMs - 300_000 },
    { id: "b", seconds: 660, timestampMs: nowMs - 120_000 },
  ]] ]);
  const baseline = estimateVehicleProgress(movingVehicle(observationMs), movingTrip, movingRouteData, "t", nowMs);
  const congested = estimateVehicleProgress(movingVehicle(observationMs), movingTrip, movingRouteData, "t", nowMs, {
    segmentTravelHistory: history,
  });
  assert.equal(congested.trafficLabel, "混雑傾向");
  assert.equal(congested.trafficSampleCount, 2);
  assert.ok(congested.segmentProgress < baseline.segmentProgress);
  assert.ok(congested.targetEtaMs > baseline.targetEtaMs);
  assert.match(congested.correctionLabel, /先行車2件・混雑傾向/);
});

test("推定だけでは次停留所を通過させず94%で更新を待つ", () => {
  const observationMs = scheduledTimestampMs("20260719", 36240);
  const model = buildMotionModel(movingVehicle(observationMs), movingTrip, movingRouteData, "20260719", observationMs + 900_000);
  assert.equal(model.previousIndex, 1);
  assert.equal(model.nextIndex, 2);
  assert.equal(model.segmentProgress, 0.94);
  assert.equal(model.progressCapped, true);
});

test("区間履歴を期限付きで保存・復元する", () => {
  const nowMs = Date.parse("2026-07-19T09:00:00+09:00");
  const history = new Map([["r1|p>n", [
    { id: "recent", seconds: 180, timestampMs: nowMs - 60_000 },
    { id: "old", seconds: 200, timestampMs: nowMs - 20 * 86_400_000 },
  ]] ]);
  const stored = serializeSegmentTravelHistory(history, nowMs, 14 * 86_400_000);
  const restored = deserializeSegmentTravelHistory(stored, nowMs, 14 * 86_400_000);
  assert.deepEqual(restored.get("r1|p>n").map((sample) => sample.id), ["recent"]);
  const estimate = estimateSegmentTravelTime(restored, "r1", "p", "n", 240, nowMs);
  assert.equal(estimate.sampleCount, 1);
});

test("到着予測は単一値ではなく誤差範囲を表示できる", () => {
  const nowMs = Date.parse("2026-07-19T09:00:00+09:00");
  assert.equal(formatEtaRange(nowMs + 20_000, nowMs + 40_000, nowMs), "まもなく");
  assert.match(formatEtaRange(nowMs + 70_000, nowMs + 150_000, nowMs), /約1〜3分/);
});

const cumulativeRouteData = {
  stops: {
    before: { stop_name: "千石一丁目", lat: 35.0, lon: 139.00 },
    ishijima: { stop_name: "石島", lat: 35.0, lon: 139.01 },
    ogibashi: { stop_name: "扇橋一丁目", lat: 35.0, lon: 139.02 },
    sarue: { stop_name: "猿江一丁目", lat: 35.0, lon: 139.03 },
  },
  services: movingRouteData.services,
};
const cumulativeTrip = {
  trip_id: "cumulative",
  service_id: "svc",
  headsign: "錦糸町駅前",
  direction_id: "0",
  stop_times: [
    ["before", 36000, 36000, 1],
    ["ishijima", 36120, 36120, 2],
    ["ogibashi", 36360, 36360, 3],
    ["sarue", 36540, 36540, 4],
  ],
};

function cumulativeVehicle({ timestampMs, sequence = 2, status = 2, hasCurrentStatus = false, longitude = 139.005, stopId = "ishijima" }) {
  return {
    entityId: "cumulative-entity",
    trip: { tripId: "cumulative", routeId: "r2", directionId: 0, startDate: "20260719" },
    currentStopSequence: sequence,
    currentStatus: status,
    hasCurrentStatus,
    timestamp: Math.floor(timestampMs / 1000),
    stopId,
    position: { latitude: 35.0, longitude },
    vehicle: { id: "cumulative-bus", label: "G702" },
  };
}

test("停留所と一致する公開座標を使わず報告停留所から次区間を推定する", () => {
  const observationMs = scheduledTimestampMs("20260719", 36120);
  const nowMs = observationMs + 120_000;
  const vehicle = cumulativeVehicle({
    timestampMs: observationMs,
    sequence: 2,
    status: 2,
    longitude: 139.01,
  });
  const model = buildMotionModel(vehicle, cumulativeTrip, cumulativeRouteData, "20260719", nowMs);
  assert.equal(model.previousIndex, 1);
  assert.equal(model.nextIndex, 2);
  assert.ok(model.segmentProgress > 0.45 && model.segmentProgress < 0.55);
  const estimate = estimateVehicleProgress(vehicle, cumulativeTrip, cumulativeRouteData, "sarue", nowMs);
  assert.match(estimate.currentLabel, /石島〜扇橋一丁目間（推定）/);
  assert.equal(estimate.minutes, 5);
});

test("石島停車中から猿江一丁目までは各区間時間を累積して7分とする", () => {
  const nowMs = scheduledTimestampMs("20260719", 36120);
  const vehicle = cumulativeVehicle({
    timestampMs: nowMs,
    sequence: 2,
    status: 1,
    hasCurrentStatus: true,
    longitude: 139.01,
  });
  const estimate = estimateVehicleProgress(vehicle, cumulativeTrip, cumulativeRouteData, "sarue", nowMs);
  assert.equal(estimate.minutes, 7);
  assert.equal(estimate.targetEtaMs - nowMs, 420_000);
});

test("後続停留所の到着予測は石島4分・猿江7分のように単調増加する", () => {
  const nowMs = scheduledTimestampMs("20260719", 36120);
  const vehicle = cumulativeVehicle({
    timestampMs: nowMs,
    sequence: 2,
    status: 1,
    hasCurrentStatus: true,
    longitude: 139.01,
  });
  const future = buildFutureStopEstimates(vehicle, cumulativeTrip, cumulativeRouteData, nowMs, 10);
  assert.deepEqual(future.map((item) => item.stop_name), ["石島", "扇橋一丁目", "猿江一丁目"]);
  assert.equal(future[1].eta_ms - nowMs, 240_000);
  assert.equal(future[2].eta_ms - nowMs, 420_000);
  assert.ok(future[0].eta_ms < future[1].eta_ms && future[1].eta_ms < future[2].eta_ms);
});

test("後続区間にも先行車の混雑実績を累積する", () => {
  const nowMs = scheduledTimestampMs("20260719", 36120);
  const vehicle = cumulativeVehicle({
    timestampMs: nowMs,
    sequence: 2,
    status: 1,
    hasCurrentStatus: true,
    longitude: 139.01,
  });
  const history = new Map([["r2|ogibashi>sarue", [
    { id: "a", seconds: 360, timestampMs: nowMs - 300_000 },
    { id: "b", seconds: 420, timestampMs: nowMs - 120_000 },
  ]] ]);
  const estimate = estimateVehicleProgress(vehicle, cumulativeTrip, cumulativeRouteData, "sarue", nowMs, {
    segmentTravelHistory: history,
  });
  assert.ok(estimate.targetEtaMs - nowMs > 420_000);
});
