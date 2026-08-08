import test from "node:test";
import assert from "node:assert/strict";
import {
  collectSegmentEvents,
  buildCompactDailyGroups,
  chunkUniqueKeys,
  compactOneCompletedTokyoDay,
  isSameVehicleConsecutive,
} from "../../worker/worker.js";

function vehicle(stopId, sequence, timestamp, overrides = {}) {
  return {
    entityId: "entity-1",
    trip: { tripId: "trip-1", routeId: "route-1", directionId: 0 },
    stopId,
    currentStopSequence: sequence,
    timestamp,
    position: { latitude: 35 + sequence / 100, longitude: 139 + sequence / 100 },
    vehicle: { id: "vehicle-1" },
    ...overrides,
  };
}

test("Worker収集処理が連続停留所から1件の区間イベントを作る", () => {
  const state = { vehicles: {}, candidates: [] };
  assert.equal(collectSegmentEvents({ vehicles: [vehicle("a", 1, 1000)] }, state, 1_000_000).length, 0);
  const events = collectSegmentEvents({ vehicles: [vehicle("b", 2, 1120)] }, state, 1_120_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].segment_key, "route-1|0|a>b");
  assert.equal(events[0].seconds, 120);
  assert.ok(Number.isFinite(events[0].latitude));
});

test("便変更、停留所飛ばし、極端な所要時間を学習しない", () => {
  const state = { vehicles: {}, candidates: [] };
  collectSegmentEvents({ vehicles: [vehicle("a", 1, 1000)] }, state);
  assert.equal(collectSegmentEvents({ vehicles: [vehicle("c", 3, 1120)] }, state).length, 0);
  assert.equal(collectSegmentEvents({ vehicles: [vehicle("d", 4, 1130, { trip: { tripId: "other", routeId: "route-1", directionId: 0 } })] }, state).length, 0);
});

test("同一車両でも停留所が連続するときだけ連続異常として扱う", () => {
  const event = { vehicle_id: "v1", from_stop_id: "b" };
  assert.equal(isSameVehicleConsecutive({ vehicleId: "v1", toStopId: "b" }, event), true);
  assert.equal(isSameVehicleConsecutive({ vehicleId: "v1", toStopId: "x" }, event), false);
  assert.equal(isSameVehicleConsecutive({ vehicleId: "v2", toStopId: "b" }, event), false);
});

test("D1検索キーは重複を除いてSQL変数上限以下へ分割する", () => {
  const keys = [...Array.from({ length: 160 }, (_, index) => `s${index}`), "s0", "s1"];
  const chunks = chunkUniqueKeys(keys);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [75, 75, 10]);
  assert.equal(new Set(chunks.flat()).size, 160);
});

test("完了した東京日付を1日ずつ日次R2オブジェクトへ圧縮する", async () => {
  const bucket = memoryBucket(new Map([
    ["hourly/2026-08-07/14.json", { events: [{ id: "d7" }] }], // 8/7 23:00 JST
    ["hourly/2026-08-07/15.json", { events: [{ id: "d8a" }] }], // 8/8 00:00 JST
    ["hourly/2026-08-08/14.json", { events: [{ id: "d8b" }] }], // 8/8 23:00 JST
    ["hourly/2026-08-08/15.json", { events: [{ id: "d9" }] }], // 8/9 00:00 JST
  ]));
  const result = await compactOneCompletedTokyoDay(bucket, new Date("2026-08-08T22:00:00Z"));
  assert.equal(result.dateKey, "2026-08-07");
  assert.equal(result.remainingCompletedDays, 1);
  assert.equal(bucket.values.has("hourly/2026-08-07/14.json"), false);
  assert.equal(bucket.values.get("daily-v2/2026-08-07.json").version, 2);
  assert.equal(bucket.values.get("daily-v2/2026-08-07.json").groups.length, 0);
  assert.equal(bucket.values.has("hourly/2026-08-07/15.json"), true);
});

test("日次イベントを区間・曜日・15分枠ごとの軽量サンプルへ変換する", () => {
  const at = Date.parse("2026-08-07T23:07:00Z"); // 土曜08:07 JST
  const common = {
    segment_key: "r|0|a>b", route_id: "r", direction_id: 0,
    from_stop_id: "a", to_stop_id: "b", timestamp_ms: at,
  };
  const groups = buildCompactDailyGroups([
    { ...common, seconds: 100, anomalous: false },
    { ...common, seconds: 120, timestamp_ms: at + 60_000, anomalous: false },
    { ...common, seconds: 900, anomalous: true },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].day_type, "saturday");
  assert.equal(groups[0].time_bin, "08:00");
  assert.deepEqual(groups[0].samples.map((sample) => sample[0]), [100, 120]);
});

function memoryBucket(initial) {
  const values = initial;
  return {
    values,
    async list({ prefix }) {
      return {
        objects: [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({
          key, uploaded: new Date("2026-08-08T00:00:00Z"),
        })),
        truncated: false,
      };
    },
    async head(key) { return values.has(key) ? { key } : null; },
    async get(key) {
      if (!values.has(key)) return null;
      return { async json() { return structuredClone(values.get(key)); } };
    },
    async put(key, body) { values.set(key, JSON.parse(body)); },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
  };
}
