import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFutureStopEstimates,
  buildMotionModel,
  decodeGtfsRealtime,
  estimateVehicleProgress,
  fetchRealtimeVehicles,
  formatEtaRange,
  isRealtimeFeedStale,
  realtimeFeedAgeMs,
  recordVehicleObservations,
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

function movingVehicle(timestampMs, longitude = 139.01, status = 2) {
  return {
    entityId: "moving-entity",
    trip: { tripId: "moving", startDate: "20260719" },
    currentStopSequence: 2,
    currentStatus: status,
    timestamp: Math.floor(timestampMs / 1000),
    stopId: "n",
    position: { latitude: 35.0, longitude },
    vehicle: { id: "moving-bus", label: "M1" },
  };
}

test("配信遅延に最大30秒の先読みを加えて停留所間を補間する", () => {
  const observationMs = scheduledTimestampMs("20260719", 36100);
  const nowMs = observationMs + 20_000;
  const vehicle = movingVehicle(observationMs);
  const withoutLead = estimateVehicleProgress(vehicle, movingTrip, movingRouteData, "t", nowMs, {
    anticipationMaxSeconds: 0,
  });
  const corrected = estimateVehicleProgress(vehicle, movingTrip, movingRouteData, "t", nowMs, {
    anticipationMaxSeconds: 30,
    anticipationSegmentRatio: 0.25,
  });
  assert.equal(Math.round(corrected.anticipationSeconds), 30);
  assert.ok(corrected.segmentProgress > corrected.observedProgress);
  assert.ok(corrected.targetEtaMs < withoutLead.targetEtaMs);
  assert.ok(withoutLead.targetEtaMs - corrected.targetEtaMs >= 29_000);
  assert.match(corrected.correctionLabel, /先読み30秒/);
});

test("短い停留所間では先読みを区間時間の25%に制限する", () => {
  const shortTrip = {
    ...movingTrip,
    stop_times: [["p", 36000, 36000, 1], ["n", 36060, 36060, 2], ["t", 36360, 36360, 3]],
  };
  const observationMs = scheduledTimestampMs("20260719", 36020);
  const model = buildMotionModel(movingVehicle(observationMs), shortTrip, movingRouteData, "20260719", observationMs, {
    anticipationMaxSeconds: 30,
    anticipationSegmentRatio: 0.25,
  });
  assert.equal(model.segmentDurationSeconds, 60);
  assert.equal(model.anticipationSeconds, 15);
});

test("停車中は30秒先読みを適用しない", () => {
  const observationMs = scheduledTimestampMs("20260719", 36240);
  const vehicle = movingVehicle(observationMs, 139.04, 1);
  const model = buildMotionModel(vehicle, movingTrip, movingRouteData, "20260719", observationMs + 20_000, {
    anticipationMaxSeconds: 30,
  });
  assert.equal(model.isStopped, true);
  assert.equal(model.anticipationSeconds, 0);
  assert.equal(model.segmentProgress, 1);
});

test("連続する位置観測を履歴として保持する", () => {
  const history = new Map();
  const firstMs = scheduledTimestampMs("20260719", 36060);
  const secondMs = firstMs + 20_000;
  recordVehicleObservations(history, { vehicles: [movingVehicle(firstMs, 139.005)] });
  recordVehicleObservations(history, { vehicles: [movingVehicle(secondMs, 139.012)] });
  assert.equal(history.get("moving-bus").length, 2);
  const model = buildMotionModel(movingVehicle(secondMs, 139.012), movingTrip, movingRouteData, "20260719", secondMs + 10_000, {
    observationHistory: history,
  });
  assert.ok(model.progressRate > 0);
  assert.ok(model.segmentProgress > model.observedProgress);
});

test("到着予測は単一値ではなく誤差範囲を表示できる", () => {
  const nowMs = Date.parse("2026-07-19T09:00:00+09:00");
  assert.equal(formatEtaRange(nowMs + 20_000, nowMs + 40_000, nowMs), "まもなく");
  assert.match(formatEtaRange(nowMs + 70_000, nowMs + 150_000, nowMs), /約1〜3分/);
});
