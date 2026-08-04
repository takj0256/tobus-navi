import test from "node:test";
import assert from "node:assert/strict";
import { collectSegmentEvents } from "../../worker/worker.js";

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
