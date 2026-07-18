import test from "node:test";
import assert from "node:assert/strict";
import { decodeGtfsRealtime, estimateVehicleProgress, buildFutureStopEstimates } from "../../js/realtime.js";
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
