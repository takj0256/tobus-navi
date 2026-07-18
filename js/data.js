import { haversineMeters } from "./geo.js";

export async function loadDataset(url = "./data/stops.json") {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`停留所データを読み込めませんでした（${response.status}）。`);
  const dataset = await response.json();
  if (!dataset || !Array.isArray(dataset.stops)) throw new Error("停留所データの形式が正しくありません。");
  return dataset;
}

export function nearbyStops(stops, latitude, longitude, radiusMeters) {
  return stops
    .map((stop) => ({
      ...stop,
      distance: haversineMeters(latitude, longitude, Number(stop.lat), Number(stop.lon)),
    }))
    .filter((stop) => Number.isFinite(stop.distance) && stop.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance || a.stop_name.localeCompare(b.stop_name, "ja"));
}

export function searchStops(stops, rawQuery) {
  const query = normalizeSearchText(rawQuery);
  if (!query) return [];

  return stops
    .map((stop) => {
      const searchable = [
        stop.stop_name,
        stop.stop_name_kana,
        stop.platform_code,
        ...(stop.routes || []).flatMap((route) => [route.route_name, route.headsign]),
      ].filter(Boolean).map(normalizeSearchText).join(" ");

      let score = 0;
      const stopName = normalizeSearchText(stop.stop_name);
      if (stopName === query) score += 100;
      if (stopName.startsWith(query)) score += 50;
      if (stopName.includes(query)) score += 25;
      if (searchable.includes(query)) score += 10;
      return { ...stop, searchScore: score };
    })
    .filter((stop) => stop.searchScore > 0)
    .sort((a, b) => b.searchScore - a.searchScore || a.stop_name.localeCompare(b.stop_name, "ja"))
    .slice(0, 30);
}

export function normalizeSearchText(value = "") {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replace(/[\s　]/g, "");
}
