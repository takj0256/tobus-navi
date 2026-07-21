import test from "node:test";
import assert from "node:assert/strict";
import { formatDistance, haversineMeters, projectPointToSegmentMeters } from "../../js/geo.js";

test("同一地点のHaversine距離は0になる", () => {
  assert.equal(haversineMeters(35, 139, 35, 139), 0);
});

test("東京駅と新宿駅の距離は概ね6km台になる", () => {
  const distance = haversineMeters(35.681236, 139.767125, 35.690921, 139.700258);
  assert.ok(distance > 5_000 && distance < 8_000, `distance=${distance}`);
});

test("距離表示をmとkmで切り替える", () => {
  assert.equal(formatDistance(123.4), "123 m");
  assert.equal(formatDistance(1_234), "1.2 km");
});


test("点を停留所間の線分へ投影して進行率を求める", () => {
  const result = projectPointToSegmentMeters(35.0, 139.005, 35.0, 139.0, 35.0, 139.01);
  assert.ok(Math.abs(result.fraction - 0.5) < 0.01);
  assert.ok(result.distanceMeters < 1);
});
