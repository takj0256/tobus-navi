import { normalizeSearchText } from "./data.js";

const TYPE_PRIORITY = {
  stop: 30,
  route: 20,
  destination: 10,
};

export function buildSuggestionIndex(stops) {
  const entries = new Map();

  const add = (type, value, aliases = []) => {
    const displayValue = String(value || "").trim();
    if (!displayValue) return;
    const key = `${type}:${normalizeSearchText(displayValue)}`;
    const searchText = [displayValue, ...aliases]
      .filter(Boolean)
      .map(normalizeSearchText)
      .join(" ");

    if (!entries.has(key)) {
      entries.set(key, {
        type,
        value: displayValue,
        searchText,
      });
    } else if (searchText.length > entries.get(key).searchText.length) {
      entries.get(key).searchText = searchText;
    }
  };

  for (const stop of stops || []) {
    add("stop", stop.stop_name, [stop.stop_name_kana, stop.platform_code]);
    for (const route of stop.routes || []) {
      add("route", route.route_name);
      add("destination", route.headsign);
    }
  }

  return [...entries.values()];
}

export function suggestSearchTerms(index, rawQuery, limit = 8) {
  const query = normalizeSearchText(rawQuery);
  if (!query || limit <= 0) return [];

  return (index || [])
    .map((entry) => {
      const normalizedValue = normalizeSearchText(entry.value);
      let score = 0;
      if (normalizedValue === query) score += 1000;
      else if (normalizedValue.startsWith(query)) score += 500;
      else if (normalizedValue.includes(query)) score += 250;
      else if (entry.searchText.includes(query)) score += 100;
      score += TYPE_PRIORITY[entry.type] || 0;
      score -= Math.min(normalizedValue.length, 80) / 100;
      return { ...entry, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.value.localeCompare(b.value, "ja"))
    .slice(0, limit)
    .map(({ score, searchText, ...entry }) => entry);
}

export function suggestionTypeLabel(type) {
  if (type === "stop") return "停留所";
  if (type === "route") return "系統";
  if (type === "destination") return "行き先";
  return "候補";
}
