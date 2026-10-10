import test from "node:test";
import assert from "node:assert/strict";
import { describeGtfsRefresh } from "../../js/data.js";

test("GTFS refresh distinguishes stale, unavailable and newer revision", () => {
  const now = Date.parse("2026-10-11T00:00:00Z");
  const status = { status: "validated", checked_at: "2026-10-10T23:00:00Z", revision: "b",
    weekly_audit: { checked_at: "2026-10-05T00:00:00Z" } };
  assert.match(describeGtfsRefresh(status, "a", now), /新版があります/);
  assert.doesNotMatch(describeGtfsRefresh(status, "b", now), /新版があります|確認が古い/);
  assert.match(describeGtfsRefresh(status, "b", now + 40 * 3600 * 1000), /確認が古い/);
  assert.match(describeGtfsRefresh(null, "b", now), /未確認/);
});
