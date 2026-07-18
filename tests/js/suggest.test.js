import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSuggestionIndex,
  suggestSearchTerms,
  suggestionTypeLabel,
} from "../../js/suggest.js";

const stops = [
  {
    stop_id: "s1",
    stop_name: "新宿駅西口",
    stop_name_kana: "しんじゅくえきにしぐち",
    platform_code: "1番のりば",
    routes: [
      { route_name: "都01", headsign: "渋谷駅前" },
      { route_name: "王78", headsign: "王子駅前" },
    ],
  },
  {
    stop_id: "s2",
    stop_name: "新宿駅西口",
    stop_name_kana: "しんじゅくえきにしぐち",
    platform_code: "2番のりば",
    routes: [
      { route_name: "都01", headsign: "渋谷駅前" },
    ],
  },
];

const index = buildSuggestionIndex(stops);

test("同じ停留所名・系統・行き先を候補内で重複させない", () => {
  assert.equal(index.filter((entry) => entry.type === "stop" && entry.value === "新宿駅西口").length, 1);
  assert.equal(index.filter((entry) => entry.type === "route" && entry.value === "都01").length, 1);
  assert.equal(index.filter((entry) => entry.type === "destination" && entry.value === "渋谷駅前").length, 1);
});

test("停留所名の前方一致候補を返す", () => {
  const result = suggestSearchTerms(index, "新宿", 8);
  assert.equal(result[0].type, "stop");
  assert.equal(result[0].value, "新宿駅西口");
});

test("かな入力でも停留所名候補を返す", () => {
  const result = suggestSearchTerms(index, "しんじゅく", 8);
  assert.equal(result[0].value, "新宿駅西口");
});

test("系統番号と行き先を候補として返す", () => {
  assert.deepEqual(suggestSearchTerms(index, "都0", 8)[0], { type: "route", value: "都01" });
  assert.deepEqual(suggestSearchTerms(index, "渋谷", 8)[0], { type: "destination", value: "渋谷駅前" });
});

test("候補数の上限を守る", () => {
  const many = Array.from({ length: 20 }, (_, indexNumber) => ({
    type: "stop",
    value: `駅前${indexNumber}`,
    searchText: `駅前${indexNumber}`,
  }));
  assert.equal(suggestSearchTerms(many, "駅前", 5).length, 5);
});

test("候補種別を日本語表示する", () => {
  assert.equal(suggestionTypeLabel("stop"), "停留所");
  assert.equal(suggestionTypeLabel("route"), "系統");
  assert.equal(suggestionTypeLabel("destination"), "行き先");
});
