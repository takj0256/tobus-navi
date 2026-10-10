import test from "node:test";
import assert from "node:assert/strict";
import {
  buildApproachLanes,
  buildPlatformApproachBoard,
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

test("走行中の車両は停留所間の進行率をマーカー位置へ反映する", () => {
  const vehicle = {
    routeKey: entry1.routeKey,
    route: entry1.route,
    routeData: entry1.routeData,
    trip: entry1.routeData.trips[0],
    vehicle: { currentStatus: 2, vehicle: { id: "bus-segment", label: "S1" } },
    stopsAway: 1,
    segmentProgress: 0.6,
    etaLabel: "約3〜4分",
    minutes: 3,
    currentLabel: "一つ前へ走行中",
  };
  vehicle.combinedVehicleId = combinedVehicleKey(vehicle);
  const lanes = buildApproachLanes([entry1], [vehicle], "target", 4);
  assert.equal(lanes[0].markers[0].lane_index, 1);
  assert.ok(Math.abs(lanes[0].markers[0].segment_offset - 0.4) < 1e-9);
  assert.equal(lanes[0].markers[0].eta_label, "約3〜4分");
});

function boardVehicle(entry, id, away = 2, trip = entry.routeData.trips[0]) {
  return {
    ...entry, trip, vehicle: { currentStatus: 1, vehicle: { id, label: id } },
    combinedVehicleId: `${entry.routeKey}::${id}`, stopsAway: away,
    minutes: 6, etaLabel: "約6分", currentLabel: "二つ前に停車中",
  };
}

test("別系統・別行き先でも同一の停留所列は1回表示し全車両に系統と行き先を残す", () => {
  const board = buildPlatformApproachBoard([entry1, entry2], [boardVehicle(entry1, "A"), boardVehicle(entry2, "B")], "target");
  assert.equal(board.stops.length, 4);
  assert.equal(board.columns[2].length, 1);
  assert.equal(board.markers[0].node_id, board.markers[1].node_id);
  assert.deepEqual(board.markers.map((m) => [m.route_name, m.headsign]), [["錦13", "錦糸町駅前"], ["東22", "東京駅丸の内北口"]]);
});

test("同系統の異なる行き先も共通区間を重複表示しない", () => {
  const other = makeEntry("r1", "錦13", "別の行き先", "other", 36000);
  const board = buildPlatformApproachBoard([entry1, other], [boardVehicle(entry1, "A"), boardVehicle(other, "B")], "target");
  assert.equal(board.stops.length, 4);
  assert.equal(board.markers.length, 2);
  assert.equal(board.markers[1].headsign, "別の行き先");
});

test("分岐前の別停留所は分け、合流後の共通停留所へ正しく結ぶ", () => {
  const branch = structuredClone(entry2);
  branch.routeData.trips[0].stop_times[1][0] = "branch";
  branch.routeData.stops.branch = { stop_name: "分岐側" };
  const board = buildPlatformApproachBoard([entry1, branch], [boardVehicle(entry1, "A"), boardVehicle(branch, "B")], "target");
  assert.equal(board.stops.filter((s) => s.stop_id === "c").length, 1);
  assert.equal(board.columns[2].length, 2);
  assert.notEqual(board.markers[0].node_id, board.markers[1].node_id);
  const downstream = board.columns[1][0].node_id;
  assert.ok(board.columns[2].every((s) => s.downstream_node_id === downstream));
  assert.equal(board.stops.filter((s) => s.stop_id === "a").length, 1);
  assert.equal(board.columns[3][0].downstream_node_ids.length, 2);
});

test("同名でも別stop_idは統合しない", () => {
  const other = structuredClone(entry2);
  other.routeData.trips[0].stop_times[1][0] = "other-platform";
  other.routeData.stops["other-platform"] = { stop_name: "二つ前" };
  const board = buildPlatformApproachBoard([entry1, other], [], "target");
  assert.equal(board.columns[2].length, 2);
});

test("同じ系統の実車ごとの異なる経路を代表便へ押し込まない", () => {
  const trip = structuredClone(entry1.routeData.trips[0]);
  trip.stop_times[1][0] = "variant";
  const board = buildPlatformApproachBoard([entry1], [boardVehicle(entry1, "A"), boardVehicle(entry1, "B", 2, trip)], "target");
  assert.equal(board.columns[2].length, 2);
  assert.notEqual(board.markers[0].node_id, board.markers[1].node_id);
});

test("表示範囲外の車両も消さず実際の距離と現在地を保持する", () => {
  const vehicle = boardVehicle(entry1, "A", 8);
  const board = buildPlatformApproachBoard([entry1], [vehicle], "target", 3);
  assert.equal(board.columns.length, 3);
  assert.equal(board.markers[0].lane_index, 2);
  assert.equal(board.markers[0].stops_away, 8);
  assert.equal(board.markers[0].is_overflow, true);
  assert.equal(board.hidden_stop_count, 1);
});

test("循環で同じ停留所を再訪してもノードを誤結合しない", () => {
  const trip = structuredClone(entry1.routeData.trips[0]);
  trip.stop_times = [["target", 0, 0, 1], ["c", 1, 1, 2], ["target", 2, 2, 3]];
  const vehicle = { ...boardVehicle(entry1, "A", 2, trip), targetIndex: 2 };
  const board = buildPlatformApproachBoard([entry1], [vehicle], "target");
  assert.equal(board.stops.filter((s) => s.stop_id === "target").length, 2);
  assert.notEqual(board.stops[0].node_id, board.markers[0].node_id);
});

test("接近車両がない場合も共通時刻表経路を1回表示する", () => {
  const board = buildPlatformApproachBoard([entry1, entry2], [], "target");
  assert.equal(board.stops.length, 4);
  assert.equal(board.markers.length, 0);
  assert.deepEqual(buildPlatformApproachBoard([], [], "target").columns, []);
});

test("乗車停留所へ走行中のバスを到着済みの枠に置かない", () => {
  const vehicle = { ...boardVehicle(entry1, "A", 0), currentIndex: 2, nextIndex: 3, targetIndex: 3, segmentProgress: 0.6 };
  const board = buildPlatformApproachBoard([entry1], [vehicle], "target");
  assert.equal(board.markers[0].node_id, board.columns[1][0].node_id);
  assert.equal(board.markers[0].stops_away, 1);
  assert.equal(board.markers[0].is_moving, true);
  assert.equal(board.markers[0].segment_progress, 0.6);
});

test("共通停留所までの停留所数が違う便も同じ枠へまとめる", () => {
  const other = structuredClone(entry2);
  other.routeData.trips[0].stop_times.splice(2, 0, ["extra", 1, 1, 9]);
  const board = buildPlatformApproachBoard([entry1, other], [boardVehicle(entry1, "A", 2), boardVehicle(other, "B", 3)], "target");
  assert.equal(board.stops.filter((s) => s.stop_id === "b").length, 1);
  assert.equal(board.markers[0].node_id, board.markers[1].node_id);
  assert.deepEqual(board.markers.map(m => m.stops_away), [2, 3]);
});

test("路線間で通過順序が逆の区間は偽の接続順を作らない", () => {
  const other = structuredClone(entry2);
  [other.routeData.trips[0].stop_times[0], other.routeData.trips[0].stop_times[1]] = [other.routeData.trips[0].stop_times[1], other.routeData.trips[0].stop_times[0]];
  const board = buildPlatformApproachBoard([entry1, other], [], "target");
  assert.equal(board.stops.filter(s => s.stop_id === "target").length, 1);
  assert.equal(board.stops.filter(s => s.stop_id === "b").length, 2);
  assert.ok(board.stops.every(s => s.downstream_node_ids.every(id => board.stops.find(x => x.node_id === id).lane_index < s.lane_index)));
});
