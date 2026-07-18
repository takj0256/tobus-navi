import test from "node:test";
import assert from "node:assert/strict";
import { nearbyStopGroups, normalizeSearchText, searchStopGroups, validateDataset } from "../../js/data.js";

const groups = [
  {
    group_id: "shinjuku",
    stop_name: "新宿駅西口",
    stop_name_kana: "しんじゅくえきにしぐち",
    lat: 35.001,
    lon: 139,
    platforms: [
      { stop_id: "s1", platform_code: "1番のりば", lat: 35.001, lon: 139, routes: [{ route_name: "都01", headsign: "新橋駅前" }] },
      { stop_id: "s2", platform_code: "2番のりば", lat: 35.0012, lon: 139, routes: [{ route_name: "王78", headsign: "王子駅前" }] },
    ],
  },
  {
    group_id: "far",
    stop_name: "遠い停留所",
    lat: 35.02,
    lon: 139,
    platforms: [{ stop_id: "s3", lat: 35.02, lon: 139, routes: [] }],
  },
];

test("同名の上り下りは1グループのまま距離検索される", () => {
  const result = nearbyStopGroups(groups, 35, 139, 500);
  assert.equal(result.length, 1);
  assert.equal(result[0].group_id, "shinjuku");
  assert.equal(result[0].platforms.length, 2);
});

test("停留所・系統・行き先で検索できる", () => {
  assert.equal(searchStopGroups(groups, "新宿")[0].group_id, "shinjuku");
  assert.equal(searchStopGroups(groups, "都01")[0].group_id, "shinjuku");
  assert.equal(searchStopGroups(groups, "王子駅前")[0].group_id, "shinjuku");
});

test("全角英数字と空白を正規化する", () => {
  assert.equal(normalizeSearchText(" ＡＢＣ １２３ "), "abc123");
});

test("Phase 4正式データを受け入れる", () => {
  assert.doesNotThrow(() => validateDataset({ meta: { demo: false, schema_version: 4 }, stop_groups: groups }));
});

test("デモ・旧形式・空データを拒否する", () => {
  assert.throws(() => validateDataset({ meta: { demo: true, schema_version: 4 }, stop_groups: groups }), /デモ/);
  assert.throws(() => validateDataset({ meta: { demo: false, schema_version: 2 }, stop_groups: groups }), /旧形式/);
  assert.throws(() => validateDataset({ meta: { demo: false, schema_version: 4 }, stop_groups: [] }), /空/);
});
