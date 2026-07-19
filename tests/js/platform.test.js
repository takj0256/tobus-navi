import test from "node:test";
import assert from "node:assert/strict";
import {
  buildApproachLanes,
  combinedVehicleKey,
  mergePlatformDepartures,
  mergePlatformTimetable,
  mergePlatformVehicles,
} from "../../js/platform.js";
import { scheduledTimestampMs } from "../../js/timetable.js";

const services = {
  calendars: {
    svc: { start_date: "20260101", end_date: "20261231", weekdays: [1, 1, 1, 1, 1, 1, 1] },
  },
  exceptions: {},
};

function makeEntry(routeId, routeName, headsign, tripId, departureSeconds) {
  return {
    routeKey: `${routeId}|${headsign}|0`,
    route: { route_id: routeId, route_name: routeName, headsign, direction_id: "0" },
    routeData: {
      route: { route_id: routeId, route_name: routeName },
      services,
      stops: {
        a: { stop_name: "三つ前" },
        b: { stop_name: "二つ前" },
        c: { stop_name: "一つ前" },
        target: { stop_name: "乗車停留所" },
      },
      trips: [{
        trip_id: tripId,
        service_id: "svc",
        headsign,
        direction_id: "0",
        stop_times: [
          ["a", departureSeconds - 900, departureSeconds - 900, 1],
          ["b", departureSeconds - 600, departureSeconds - 600, 2],
          ["c", departureSeconds - 300, departureSeconds - 300, 3],
          ["target", departureSeconds, departureSeconds, 4],
        ],
      }],
    },
  };
}

const entry1 = makeEntry("r1", "錦13", "錦糸町駅前", "t1", 10 * 3600);
const entry2 = makeEntry("r2", "東22", "東京駅丸の内北口", "t2", 10 * 3600 + 300);

test("同じのりばを使う複数系統の発車予定を時刻順に統合する", () => {
  const now = new Date(scheduledTimestampMs("20260719", 9 * 3600 + 55 * 60));
  const departures = mergePlatformDepartures([entry2, entry1], "target", now, 2);
  assert.equal(departures.length, 2);
  assert.equal(departures[0].route.route_name, "錦13");
  assert.equal(departures[1].route.route_name, "東22");
});

test("時刻表は系統・行き先ごとのグループを保持する", () => {
  const groups = mergePlatformTimetable([entry1, entry2], "target", "20260719");
  assert.equal(groups.length, 2);
  assert.equal(groups[0].departures.length, 1);
  assert.equal(groups[1].route.headsign, "東京駅丸の内北口");
});

test("複数系統の接近車両を到着順に統合する", () => {
  const baseMs = scheduledTimestampMs("20260719", 9 * 3600 + 52 * 60);
  const feed = {
    timestamp: Math.floor(baseMs / 1000),
    vehicles: [
      {
        entityId: "v2",
        trip: { tripId: "t2", startDate: "20260719" },
        currentStopSequence: 3,
        currentStatus: 1,
        timestamp: Math.floor(baseMs / 1000),
        stopId: "c",
        vehicle: { id: "bus2", label: "B2" },
      },
      {
        entityId: "v1",
        trip: { tripId: "t1", startDate: "20260719" },
        currentStopSequence: 2,
        currentStatus: 1,
        timestamp: Math.floor(baseMs / 1000),
        stopId: "b",
        vehicle: { id: "bus1", label: "B1" },
      },
    ],
  };
  const vehicles = mergePlatformVehicles([entry1, entry2], "target", feed, baseMs, { maxVehicleAgeMs: Infinity });
  assert.equal(vehicles.length, 2);
  assert.equal(vehicles[0].route.route_name, "東22");
  assert.match(vehicles[0].combinedVehicleId, /^r2\|/);
  assert.ok(vehicles[0].targetEtaMs <= vehicles[1].targetEtaMs);
});

test("停留所位置レーンは乗車停留所を先頭にして車両位置を置く", () => {
  const vehicle = {
    routeKey: entry1.routeKey,
    route: entry1.route,
    routeData: entry1.routeData,
    trip: entry1.routeData.trips[0],
    vehicle: { vehicle: { id: "bus1", label: "B1" } },
    stopsAway: 2,
    minutes: 6,
    currentLabel: "二つ前に停車中",
  };
  vehicle.combinedVehicleId = combinedVehicleKey(vehicle);
  const lanes = buildApproachLanes([entry1], [vehicle], "target", 4);
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].stops[0].stop_name, "乗車停留所");
  assert.equal(lanes[0].stops[2].stop_name, "二つ前");
  assert.equal(lanes[0].markers[0].lane_index, 2);
});
