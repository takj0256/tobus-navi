import test from "node:test";
import assert from "node:assert/strict";
import { buildLocalProfiles } from "../../tools/phase11-local-model.js";

test("daily-v2からローカル区間プロファイルを生成する", () => {
  const now = Date.parse("2026-08-16T00:00:00Z");
  const compact = {
    segment_key: "006|0|a>b", route_id: "006", direction_id: 0,
    from_stop_id: "a", to_stop_id: "b", day_type: "weekday", time_bin: "08:00",
    samples: [[100, now - 1000, "dry", "hot"], [120, now - 2000, "dry", "hot"], [140, now - 3000, "dry", "hot"]],
  };
  const result = buildLocalProfiles([{ groups: [compact] }], now);
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].median_seconds, 120);
  assert.equal(result.profiles[0].sample_count, 3);
  assert.equal(result.sourceObjects, 1);
});

test("28日より古いサンプルだけなら更新対象にしない", () => {
  const now = Date.parse("2026-08-16T00:00:00Z");
  const old = now - 29 * 86_400_000;
  const result = buildLocalProfiles([{ groups: [{
    segment_key: "x", route_id: "r", direction_id: "", from_stop_id: "a", to_stop_id: "b",
    day_type: "weekday", time_bin: "08:00", samples: [[60, old], [70, old], [80, old]],
  }] }], now);
  assert.equal(result.profiles.length, 0);
});
