import test from "node:test";
import assert from "node:assert/strict";
import { buildSuggestionIndex, suggestSearchTerms, suggestionTypeLabel } from "../../js/suggest.js";

const groups = [{
  group_id: "g1",
  stop_name: "新宿駅西口",
  stop_name_kana: "しんじゅくえきにしぐち",
  platforms: [
    { stop_id: "s1", routes: [{ route_name: "都01", headsign: "渋谷駅前" }, { route_name: "王78", headsign: "王子駅前" }] },
    { stop_id: "s2", routes: [{ route_name: "都01", headsign: "渋谷駅前" }] },
  ],
}];
const index = buildSuggestionIndex(groups);

test("同名候補を重複させない", () => {
  assert.equal(index.filter((entry) => entry.type === "stop").length, 1);
  assert.equal(index.filter((entry) => entry.value === "都01").length, 1);
});

test("かな・系統・行き先の候補を返す", () => {
  assert.equal(suggestSearchTerms(index, "しんじゅく", 8)[0].value, "新宿駅西口");
  assert.equal(suggestSearchTerms(index, "都0", 8)[0].value, "都01");
  assert.equal(suggestSearchTerms(index, "渋谷", 8)[0].value, "渋谷駅前");
});

test("候補数上限と日本語ラベル", () => {
  assert.ok(suggestSearchTerms(index, "駅", 1).length <= 1);
  assert.equal(suggestionTypeLabel("destination"), "行き先");
});
