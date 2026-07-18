/**
 * GTFSのtrip_headsignはデータとして加工せず保持し、画面表示時にだけ
 * 日本語として自然になるよう「行き」を補う。
 */
export function displayHeadsign(headsign) {
  const value = String(headsign ?? "").trim();
  if (!value) return "行き先不明";
  return /(行き|方面|循環|止まり|経由)$/.test(value) ? value : `${value}行き`;
}

export function formatPlatformLabel(platform = {}, index = 0) {
  const raw = String(platform.platform_code || "").trim();
  if (/^[0-9０-９]+$/.test(raw)) return `${raw}番のりば`;
  if (/^[0-9０-９]+番$/.test(raw)) return `${raw}のりば`;
  if (raw) return raw;
  return `${index + 1}つ目ののりば`;
}

export function destinationLabelsForPlatform(platform = {}, limit = 3) {
  const labels = [...new Set((platform.routes || [])
    .map((route) => displayHeadsign(route.headsign))
    .filter((label) => label && label !== "行き先不明"))];
  if (!labels.length) return "行き先情報なし";
  const shown = labels.slice(0, limit);
  const remaining = labels.length - shown.length;
  return `${shown.join("・")}${remaining > 0 ? ` ほか${remaining}方面` : ""}`;
}

export function destinationSummaryForGroup(platforms = [], limit = 4) {
  const labels = [...new Set(platforms.flatMap((platform) =>
    (platform.routes || []).map((route) => displayHeadsign(route.headsign))))]
    .filter((label) => label && label !== "行き先不明");
  if (!labels.length) return "行き先情報なし";
  const shown = labels.slice(0, limit);
  const remaining = labels.length - shown.length;
  return `${shown.join("・")}${remaining > 0 ? ` ほか${remaining}方面` : ""}`;
}
