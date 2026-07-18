import test from "node:test";
import assert from "node:assert/strict";
import { nearbyStops, normalizeSearchText, searchStops } from "../../js/data.js";

const stops = [
  {
    stop_id: "far",
    stop_name: "遠い停留所",
    stop_name_kana: "とおいていりゅうじょ",
    lat: 35.01,
    lon: 139,
    routes: [],
  },
  {
    stop_id: "near",
    stop_name: "新宿駅西口",
    stop_name_kana: "しんじゅくえきにしぐち",
    platform_code: "1番のりば",
    lat: 35.001,
    lon: 139,
    routes: [{ route_id: "r1", route_name: "都01", headsign: "新橋駅前" }],
  },
  {
    stop_id: "exact",
    stop_name: "新宿駅",
    stop_name_kana: "しんじゅくえき",
    lat: 35.002,
    lon: 139,
    routes: [],
  },
];

test("半径内の停留所だけを距離順に返す", () => {
  const result = nearbyStops(stops, 35, 139, 1_500);
  assert.deepEqual(result.map((stop) => stop.stop_id), ["near", "exact", "far"]);
});

test("小さい半径では遠い停留所を除外する", () => {
  const result = nearbyStops(stops, 35, 139, 500);
  assert.deepEqual(result.map((stop) => stop.stop_id), ["near", "exact"]);
});

test("完全一致を部分一致より上位にする", () => {
  const result = searchStops(stops, "新宿駅");
  assert.equal(result[0].stop_id, "exact");
  assert.ok(result.some((stop) => stop.stop_id === "near"));
});

test("駅名検索で新宿駅西口も見つかる", () => {
  const result = searchStops(stops, "新宿駅");
  assert.ok(result.some((stop) => stop.stop_name === "新宿駅西口"));
});

test("全角英数字と空白を正規化する", () => {
  assert.equal(normalizeSearchText(" ＡＢＣ １２３ "), "abc123");
});

test("系統番号と行き先でも検索できる", () => {
  assert.equal(searchStops(stops, "都01")[0].stop_id, "near");
  assert.equal(searchStops(stops, "新橋駅前")[0].stop_id, "near");
});

test("同名でもstop_id・のりばが異なる停留所は別項目として残す", () => {
  const sameNameStops = [
    {
      stop_id: "platform-1",
      stop_name: "○○駅前",
      platform_code: "1番のりば",
      lat: 35.0005,
      lon: 139.0005,
      routes: [],
    },
    {
      stop_id: "platform-2",
      stop_name: "○○駅前",
      platform_code: "2番のりば",
      lat: 35.0006,
      lon: 139.0006,
      routes: [],
    },
  ];

  const result = nearbyStops(sameNameStops, 35, 139, 500);
  assert.equal(result.length, 2);
  assert.deepEqual(new Set(result.map((stop) => stop.stop_id)), new Set(["platform-1", "platform-2"]));
});

import { validateDataset } from "../../js/data.js";

test("正式データを受け入れる", () => {
  assert.doesNotThrow(() => validateDataset({ meta: { demo: false }, stops: [stops[0]] }));
});

test("デモデータを拒否する", () => {
  assert.throws(
    () => validateDataset({ meta: { demo: true }, stops: [stops[0]] }),
    /デモデータ/,
  );
});

test("空の停留所データを拒否する", () => {
  assert.throws(
    () => validateDataset({ meta: { demo: false }, stops: [] }),
    /空です/,
  );
});
