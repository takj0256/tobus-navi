import test from "node:test";
import assert from "node:assert/strict";
import {
  addServiceDays,
  currentTokyoDateKey,
  formatGtfsClock,
  getDailyTimetable,
  getUpcomingDepartures,
  isServiceActive,
  scheduledTimestampMs,
} from "../../js/timetable.js";

const routeData = {
  route: { route_id: "r1", route_name: "都99" },
  services: {
    calendars: {
      svc: { start_date: "20260101", end_date: "20261231", weekdays: [1, 1, 1, 1, 1, 1, 1] },
    },
    exceptions: {},
  },
  trips: [
    {
      trip_id: "t1",
      service_id: "svc",
      headsign: "終点駅",
      direction_id: "0",
      stop_times: [["s1", 36000, 36000, 1], ["s2", 36600, 36600, 2]],
    },
  ],
};
const selection = { stop_id: "s1", headsign: "終点駅", direction_id: "0" };

test("GTFS時刻を表示する", () => {
  assert.equal(formatGtfsClock(25 * 3600 + 30 * 60), "01:30");
});

test("毎日運行のサービスを有効判定する", () => {
  assert.equal(isServiceActive("svc", "20260719", routeData.services), true);
});

test("例外運休を優先する", () => {
  const services = structuredClone(routeData.services);
  services.exceptions["20260719"] = { add: [], remove: ["svc"] };
  assert.equal(isServiceActive("svc", "20260719", services), false);
});

test("本日時刻表と次発を生成する", () => {
  const now = new Date(scheduledTimestampMs("20260719", 9 * 3600 + 55 * 60));
  const daily = getDailyTimetable(routeData, selection, "20260719");
  const upcoming = getUpcomingDepartures(routeData, selection, now, 5);
  assert.equal(daily.length, 1);
  assert.ok(upcoming.length >= 1);
  assert.equal(upcoming[0].trip_id, "t1");
});

test("東京日付と日付加算", () => {
  assert.equal(currentTokyoDateKey(new Date("2026-07-18T16:00:00Z")), "20260719");
  assert.equal(addServiceDays("20260719", -1), "20260718");
});
