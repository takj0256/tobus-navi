import { haversineMeters } from "./geo.js";

export async function loadDataset(url = "./data/stops.json") {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`停留所データを読み込めませんでした（${response.status}）。正式GTFS-JPから data/stops.json を生成してください。`);
  }

  const dataset = await response.json();
  validateDataset(dataset);
  return dataset;
}

export function validateDataset(dataset) {
  if (!dataset || !Array.isArray(dataset.stops)) {
    throw new Error("停留所データの形式が正しくありません。");
  }
  if (dataset.meta?.demo === true) {
    throw new Error("デモデータは正式版では使用できません。公式GTFS-JPから data/stops.json を再生成してください。");
  }
  if (dataset.stops.length === 0) {
    throw new Error("停留所データが空です。公式GTFS-JPから data/stops.json を再生成してください。");
  }
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
      const stopName = normalizeSearchText(stop.stop_name);
      const stopKana = normalizeSearchText(stop.stop_name_kana);
      const platform = normalizeSearchText(stop.platform_code);
      const routeValues = (stop.routes || []).flatMap((route) => [route.route_name, route.headsign]);
      const routeTexts = routeValues.filter(Boolean).map(normalizeSearchText);

      let score = 0;
      if (stopName === query) score += 1000;
      else if (stopName.startsWith(query)) score += 600;
      else if (stopName.includes(query)) score += 350;

      if (stopKana === query) score += 500;
      else if (stopKana.startsWith(query)) score += 300;
      else if (stopKana.includes(query)) score += 180;

      if (platform.includes(query)) score += 80;

      for (const routeText of routeTexts) {
        if (routeText === query) score += 450;
        else if (routeText.startsWith(query)) score += 250;
        else if (routeText.includes(query)) score += 120;
      }

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
