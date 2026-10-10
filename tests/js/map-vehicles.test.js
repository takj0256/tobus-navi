import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMapRouteEntries, buildRoutePatterns, sharedPlatformRouteFiles,
  selectMapVehicles, mapMarkerOffset,
} from "../../js/route-map-model.js";

const primaryFile = "routes/route-1111111111111111.json";
const sharedFile = "routes/route-2222222222222222.json";
const otherFile = "routes/route-3333333333333333.json";
const nowMs = Date.parse("2026-10-11T05:00:00Z");
const trip = (id, headsign, stopIds, direction = "0") => ({
  trip_id: id, headsign, direction_id: direction, service_id: "svc",
  stop_times: stopIds.map((stopId, index) => [stopId, 50_400 + index * 120, 50_400 + index * 120, index + 1]),
});
const primary = {
  route: { route_id: "r13", route_name: "錦13" },
  services: { calendars: {}, exceptions: {} }, shapes: {},
  stops: Object.fromEntries(["a", "target", "c", "other"].map((id, index) => [id, {
    stop_name: id === "other" ? "target" : id, lat: 35 + index * .01, lon: 139 + index * .01,
  }])),
  trips: [trip("t1", "錦糸町駅前", ["a", "target", "c"]),
    trip("t2", "晴海埠頭", ["c", "other", "a"], "1"),
    trip("t3", "別行き先", ["a", "target", "c"])],
};
const shared = { ...primary, route: { route_id: "r11", route_name: "錦11" },
  trips: [trip("t4", "亀戸駅前", ["a", "target", "c"]), trip("t5", "別乗り場", ["a", "other", "c"])] };
const entries = () => buildMapRouteEntries([
  { routeFile: primaryFile, routeData: primary }, { routeFile: sharedFile, routeData: shared },
], { primaryFile, stopId: "target" });
const vehicle = (id, tripId, routeId = "r13", sequence = 1) => ({
  entityId: id, vehicle: { id, label: id }, trip: { tripId, routeId, startDate: "20261011" },
  timestamp: nowMs / 1000, hasCurrentStatus: true, currentStatus: 1, currentStopSequence: sequence,
});
const select = (vehicles, selectedEntries = entries(), extra = {}) => selectMapVehicles(selectedEntries,
  { timestamp: nowMs / 1000, vehicles }, { nowMs, ...extra });

test("map route discovery uses exact platform ID, validates paths and deduplicates files", () => {
  const dataset = { stop_groups: [{ platforms: [
    { stop_id: "target", routes: [{ route_file: primaryFile }, { route_file: sharedFile }, { route_file: sharedFile }, { route_file: "../bad" }] },
    { stop_id: "other", routes: [{ route_file: otherFile }] },
  ] }] };
  assert.deepEqual(sharedPlatformRouteFiles(dataset, "target", primaryFile), [primaryFile, sharedFile]);
  assert.deepEqual(sharedPlatformRouteFiles(dataset, "", primaryFile), [primaryFile]);
});

test("map includes all primary-route directions and only shared-platform trips of added routes", () => {
  assert.equal(entries()[0].trips.size, 3);
  assert.deepEqual([...entries()[1].trips.keys()], ["t4"]);
  assert.equal(entries()[0].groups.length, 3);
});

test("same stop order with different destinations is not merged into the first headsign", () => {
  const patterns = buildRoutePatterns(primary);
  assert.equal(patterns.length, 3);
  assert.equal(new Set(patterns.map((pattern) => pattern.key)).size, 3);
});

test("map selects multiple vehicles on same trip, reverse direction and shared route together", () => {
  const result = select([vehicle("v1", "t1"), vehicle("v2", "t1"), vehicle("v3", "t2"), vehicle("v4", "t4", "r11")]);
  assert.equal(result.vehicles.length, 4);
  assert.deepEqual(result.vehicles.map((item) => item.headsign), ["錦糸町駅前", "錦糸町駅前", "晴海埠頭", "亀戸駅前"]);
  assert.equal(result.unmatchedTrips, 0);
});

test("passing the selected stop does not hide a bus from route-wide map", () => {
  assert.equal(select([vehicle("past", "t1", "r13", 3)]).vehicles.length, 1);
});

test("same-named opposite platform and unrelated route are not included", () => {
  const result = select([vehicle("opposite", "t5", "r11"), vehicle("unrelated", "t1", "r999")]);
  assert.equal(result.vehicles.length, 0);
  assert.equal(result.unmatchedTrips, 0);
});

test("explicit destination selection restricts matching pattern without false unknown warning", () => {
  const entry = entries()[0];
  const filtered = [{ ...entry, allowUnmatchedPosition: false, patterns: entry.groups.find((group) => group.headsign === "晴海埠頭").patterns }];
  const result = select([vehicle("v1", "t1"), vehicle("v2", "t2")], filtered);
  assert.deepEqual(result.vehicles.map((item) => item.vehicle.vehicle.id), ["v2"]);
  assert.equal(result.unmatchedTrips, 0);
});

test("physical vehicle duplicated in feed is shown once using newest observation", () => {
  const old = { ...vehicle("v1", "t1"), timestamp: nowMs / 1000 - 10 };
  const newer = vehicle("v1", "t2");
  const result = select([old, newer]);
  assert.equal(result.vehicles.length, 1);
  assert.equal(result.vehicles[0].trip.trip_id, "t2");
});

test("newest observation on another route prevents resurrecting an old matching trip", () => {
  const old = { ...vehicle("v1", "t1"), timestamp: nowMs / 1000 - 10 };
  const newer = vehicle("v1", "other-trip", "r999");
  assert.equal(select([old, newer]).vehicles.length, 0);
});

test("stale, future and unknown-age observations are not represented as current running buses", () => {
  const result = select([
    { ...vehicle("old", "t1"), timestamp: nowMs / 1000 - 301 },
    { ...vehicle("future", "t1"), timestamp: nowMs / 1000 + 61 },
  ]);
  assert.equal(result.vehicles.length, 0);
  assert.equal(result.stale, 2);
  const noTime = selectMapVehicles(entries(), { vehicles: [{ ...vehicle("unknown-time", "t1"), timestamp: undefined }] }, { nowMs });
  assert.equal(noTime.stale, 1);
});

test("feed time fallback is valid when individual timestamp is absent", () => {
  assert.equal(select([{ ...vehicle("fallback", "t1"), timestamp: undefined }]).vehicles.length, 1);
});

test("unmatched static GTFS trips and unlocated buses have distinct diagnostics", () => {
  const result = select([vehicle("unknown", "new-trip"), vehicle("unlocated", "t1", "r13", 999)]);
  assert.equal(result.unmatchedTrips, 1);
  assert.equal(result.unlocated, 1);
  assert.equal(result.vehicles.length, 0);
});

test("empty feed remains empty and overlapping offsets do not repeat after six buses", () => {
  assert.equal(select([]).vehicles.length, 0);
  const offsets = Array.from({ length: 20 }, (_, index) => JSON.stringify(mapMarkerOffset(index)));
  assert.equal(new Set(offsets).size, 20);
});

test("unknown primary-route trip can show fresh observed coordinates without inventing destination or ETA", () => {
  const result = select([{ ...vehicle("new", "new-trip"), position: { latitude: 35, longitude: 139 } }]);
  assert.equal(result.unmatchedTrips, 1);
  assert.equal(result.observedPositions, 1);
  assert.equal(result.vehicles[0].observedOnly, true);
  assert.equal(result.vehicles[0].headsign, "行き先未照合");
  assert.equal(result.vehicles[0].estimate.targetEtaMs, undefined);
});

test("unknown secondary-route, absent route ID, invalid coordinates and explicit direction are not guessed", () => {
  const position = { latitude: 35, longitude: 139 };
  const missingRoute = { ...vehicle("no-route", "new-trip"), trip: { tripId: "new-trip" }, position };
  const result = select([{ ...vehicle("secondary", "new-trip", "r11"), position }, missingRoute,
    { ...vehicle("invalid", "new-trip"), position: { latitude: 999, longitude: 139 } }]);
  assert.equal(result.vehicles.length, 0);
  assert.equal(result.unmatchedTrips, 2);
  const filtered = entries().map((entry) => ({ ...entry, allowUnmatchedPosition: false }));
  assert.equal(select([{ ...vehicle("filtered", "new-trip"), position }], filtered).vehicles.length, 0);
});
