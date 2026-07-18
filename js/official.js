const OFFICIAL_ROUTE_SEARCH_URL = "https://tobus.jp/sp/blsys/route?trn=top_move";
const OFFICIAL_STOP_SEARCH_URL = "https://tobus.jp/sp/blsys/top/stop";

export function buildOfficialUrl(stop, route) {
  // 公式サイトの固定ディープリンク仕様は保証されていないため、
  // GTFS変換時に検証済みURLを埋め込める拡張点を用意し、未設定時は公式検索画面へ遷移する。
  return route?.official_url || stop?.official_url || OFFICIAL_ROUTE_SEARCH_URL;
}

export async function openOfficial(stop, route, notify = () => {}) {
  const url = buildOfficialUrl(stop, route);
  const label = [route?.route_name, route?.headsign].filter(Boolean).join(" ");
  if (label && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(label);
      notify(`「${label}」をコピーしました。公式サイトで貼り付けて検索できます。`);
    } catch {
      notify("公式サイトを開きます。");
    }
  } else {
    notify("公式サイトを開きます。");
  }

  // 同じタブで遷移することで、await後のwindow.openがポップアップとして
  // ブロックされる問題を避ける。ブラウザの戻る操作でアプリへ戻れる。
  window.location.assign(url);
}

export function officialStopSearchUrl() {
  return OFFICIAL_STOP_SEARCH_URL;
}
