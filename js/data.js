import { haversineMeters } from "./geo.js";

export function describeGtfsRefresh(status, revision, now = Date.now()) {
  const checked = Date.parse(status?.checked_at);
  if (status?.status !== "validated" || !Number.isFinite(checked)) return "GTFS更新確認：未確認";
  const stamp = (value) => new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const stale = now - checked > 36 * 3600 * 1000 || checked - now > 60 * 1000;
  const changed = revision && status.revision && revision !== status.revision;
  return `公式GTFS確認：${stamp(checked)}${stale ? "（更新確認が古い／時計要確認）" : ""}`
    + `・停留所監査：${status.weekly_audit?.checked_at ? stamp(status.weekly_audit.checked_at) : "未確認"}`
    + (changed ? "・新版があります。最新データを読み込んでください。" : "")
    + "・工事等の臨時移設は公式データ未反映の場合があります。";
}

export async function loadDataset(url = "./data/transit-index.json") {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`交通データを読み込めませんでした（${response.status}）。GTFS-JPから data/transit-index.json を生成してください。`);
  }

  const dataset = await response.json();
  validateDataset(dataset);
  return dataset;
}

export async function loadRouteData(routeFile) {
  if (!routeFile) throw new Error("系統別データのファイル指定がありません。");
  const url = routeFile.startsWith("./") ? routeFile : `./data/${routeFile}`;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`系統別データを読み込めませんでした（${response.status}）。`);
  const data = await response.json();
  if (!data?.route || !Array.isArray(data.trips) || !data.stops) {
    throw new Error("系統別データの形式が正しくありません。");
  }
  return data;
}

export function validateDataset(dataset) {
  if (!dataset || !Array.isArray(dataset.stop_groups)) {
    throw new Error("停留所グループデータの形式が正しくありません。");
  }
  if (dataset.meta?.demo === true) {
    throw new Error("デモデータは正式版では使用できません。公式GTFS-JPから再生成してください。");
  }
  if (Number(dataset.meta?.schema_version || 0) < 5) {
    throw new Error("停留所データが旧形式です。Phase 6以降の変換スクリプトで再生成してください。");
  }
  if (dataset.stop_groups.length === 0) {
    throw new Error("停留所データが空です。公式GTFS-JPから再生成してください。");
  }
}

export function groupDistance(group, latitude, longitude) {
  const platformDistances = (group.platforms || []).map((platform) => (
    haversineMeters(latitude, longitude, Number(platform.lat), Number(platform.lon))
  )).filter(Number.isFinite);
  if (platformDistances.length) return Math.min(...platformDistances);
  return haversineMeters(latitude, longitude, Number(group.lat), Number(group.lon));
}

export function nearbyStopGroups(groups, latitude, longitude, radiusMeters) {
  return (groups || [])
    .map((group) => ({
      ...group,
      distance: groupDistance(group, latitude, longitude),
    }))
    .filter((group) => Number.isFinite(group.distance) && group.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance || a.stop_name.localeCompare(b.stop_name, "ja"));
}

export function searchStopGroups(groups, rawQuery) {
  const query = normalizeSearchText(rawQuery);
  if (!query) return [];

  return (groups || [])
    .map((group) => {
      const stopName = normalizeSearchText(group.stop_name);
      const stopKana = normalizeSearchText(group.stop_name_kana);
      const platformTexts = (group.platforms || []).flatMap((platform) => [
        platform.platform_code,
        ...(platform.routes || []).flatMap((route) => [route.route_name, route.headsign]),
      ]).filter(Boolean).map(normalizeSearchText);

      let score = 0;
      if (stopName === query) score += 1000;
      else if (stopName.startsWith(query)) score += 600;
      else if (stopName.includes(query)) score += 350;

      if (stopKana === query) score += 500;
      else if (stopKana.startsWith(query)) score += 300;
      else if (stopKana.includes(query)) score += 180;

      for (const text of platformTexts) {
        if (text === query) score += 450;
        else if (text.startsWith(query)) score += 250;
        else if (text.includes(query)) score += 120;
      }

      return { ...group, searchScore: score };
    })
    .filter((group) => group.searchScore > 0)
    .sort((a, b) => b.searchScore - a.searchScore || a.stop_name.localeCompare(b.stop_name, "ja"))
    .slice(0, 30);
}

export function flattenGroupRoutes(group) {
  return (group?.platforms || []).flatMap((platform) => (
    (platform.routes || []).map((route) => ({ ...route, platform }))
  ));
}

export function normalizeSearchText(value = "") {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replace(/[\s　]/g, "");
}
