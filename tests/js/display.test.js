import test from "node:test";
import assert from "node:assert/strict";
import {
  displayHeadsign,
  formatPlatformLabel,
  destinationLabelsForPlatform,
  destinationSummaryForGroup,
} from "../../js/display.js";

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

test("数字だけのplatform_codeをのりば表記にする", () => {
  assert.equal(formatPlatformLabel({ platform_code: "3" }, 0), "3番のりば");
  assert.equal(formatPlatformLabel({ platform_code: "3番" }, 0), "3番のりば");
});

test("のりば番号がない場合は順序を明示する", () => {
  assert.equal(formatPlatformLabel({}, 1), "2つ目ののりば");
});

test("のりばの代表行き先を重複なく要約する", () => {
  const platform = { routes: [
    { headsign: "亀戸駅前" },
    { headsign: "亀戸駅前" },
    { headsign: "錦糸町駅前" },
  ] };
  assert.equal(destinationLabelsForPlatform(platform), "亀戸駅前行き・錦糸町駅前行き");
});

test("停留所全体の行き先を上限付きで要約する", () => {
  const platforms = [
    { routes: [{ headsign: "A" }, { headsign: "B" }] },
    { routes: [{ headsign: "C" }, { headsign: "D" }, { headsign: "E" }] },
  ];
  assert.equal(destinationSummaryForGroup(platforms, 3), "A行き・B行き・C行き ほか2方面");
});
