import test from "node:test";
import assert from "node:assert/strict";
import { displayHeadsign } from "../../js/display.js";

test("空の行き先は行き先不明と表示する", () => {
  assert.equal(displayHeadsign(""), "行き先不明");
});

test("終点名だけの場合は表示時に行きを補う", () => {
  assert.equal(displayHeadsign("新橋駅前"), "新橋駅前行き");
});

test("すでに行きで終わる場合は重複して付けない", () => {
  assert.equal(displayHeadsign("新橋駅前行き"), "新橋駅前行き");
});

test("方面で終わる場合はそのまま表示する", () => {
  assert.equal(displayHeadsign("渋谷駅方面"), "渋谷駅方面");
});

test("循環・止まり・経由で終わる表示はそのまま保持する", () => {
  assert.equal(displayHeadsign("都心循環"), "都心循環");
  assert.equal(displayHeadsign("深川車庫前止まり"), "深川車庫前止まり");
  assert.equal(displayHeadsign("東京駅前経由"), "東京駅前経由");
});
