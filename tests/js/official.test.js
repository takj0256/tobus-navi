import test from "node:test";
import assert from "node:assert/strict";
import { buildOfficialUrl, officialStopSearchUrl } from "../../js/official.js";

const fallback = "https://tobus.jp/sp/blsys/route?trn=top_move";

test("routeの検証済みURLを最優先する", () => {
  assert.equal(
    buildOfficialUrl({ official_url: "https://example.com/stop" }, { official_url: "https://example.com/route" }),
    "https://example.com/route",
  );
});

test("route URLがなければstop URLを使う", () => {
  assert.equal(buildOfficialUrl({ official_url: "https://example.com/stop" }, {}), "https://example.com/stop");
});

test("検証済みURLがなければ公式系統検索へフォールバックする", () => {
  assert.equal(buildOfficialUrl({}, {}), fallback);
});

test("停留所検索URLを返す", () => {
  assert.equal(officialStopSearchUrl(), "https://tobus.jp/sp/blsys/top/stop");
});
