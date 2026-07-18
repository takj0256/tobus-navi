/**
 * GTFSのtrip_headsignはデータとして加工せず保持し、画面表示時にだけ
 * 日本語として自然になるよう「行き」を補う。
 */
export function displayHeadsign(headsign) {
  const value = String(headsign ?? "").trim();
  if (!value) return "行き先不明";
  return /(行き|方面|循環|止まり|経由)$/.test(value) ? value : `${value}行き`;
}
