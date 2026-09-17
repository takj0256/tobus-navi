import { buildLocalProfiles } from './phase11-local-model.js';

const DAY = 86400000;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const median = values => {
  const a = [...values].sort((a, b) => a - b), m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const keyOf = g => `${g.segment_key}|${g.day_type}|${g.time_bin}`;
const tokyoDate = ms => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
function seasonDay(ms) {
  const date = new Date(ms + 9 * 3600000);
  // Use a leap reference year so March dates do not shift between years.
  return (Date.UTC(2000, date.getUTCMonth(), date.getUTCDate()) - Date.UTC(2000, 0, 1)) / DAY;
}

export function buildHistoryProfiles(payloads, nowMs = Date.now()) {
  const groups = new Map(), dates = new Set();
  for (const payload of payloads) {
    if (!payload?.date_key || dates.has(payload.date_key)) throw Error('One revision per observation date is required');
    dates.add(payload.date_key);
    for (const g of payload.groups || []) {
      const key = keyOf(g), item = groups.get(key) || { meta: g, samples: new Map() };
      for (const s of g.samples || []) {
        if (!Number.isFinite(s[0]) || s[0] < 15 || s[0] > 1800 || !Number.isFinite(s[1]) || s[1] >= nowMs) continue;
        const id = s[5] ? `event:${s[5]}` : `legacy:${JSON.stringify(s)}`;
        if (item.samples.has(id) && JSON.stringify(item.samples.get(id)) !== JSON.stringify(s)) throw Error('Conflicting event revision');
        item.samples.set(id, s);
      }
      groups.set(key, item);
    }
  }
  const recentPayload = { groups: [...groups.values()].map(x => ({ ...x.meta, samples: [...x.samples.values()].filter(s => s[1] >= nowMs - 28 * DAY) })) };
  // Retain the current robust 7/28-day behavior as the recent component.
  const recent = buildLocalProfiles([recentPayload], nowMs);
  const recentMap = new Map(recent.profiles.map(p => [keyOf(p), p]));
  const profiles = [];
  for (const [key, group] of groups) {
    const all = [...group.samples.values()], old = all.filter(s => s[1] < nowMs - 28 * DAY);
    const target = seasonDay(nowMs);
    const seasonal = old.filter(s => {
      const d = Math.abs(seasonDay(s[1]) - target);
      return Math.min(d, 366 - d) <= 45;
    });
    // Do not call a few weeks of data a learned annual pattern.
    const hasPriorYear = seasonal.some(s => nowMs - s[1] >= 300 * DAY);
    const seasonalDays = new Set(seasonal.map(s => tokyoDate(s[1]))).size;
    const selected = hasPriorYear && seasonalDays >= 4 && seasonal.length >= 12 ? seasonal : old;
    const baseDays = new Set(selected.map(s => tokyoDate(s[1]))).size;
    const p = recentMap.get(key);
    if (selected.length < 12 || baseDays < 4) {
      if (p) profiles.push({ ...p, history: { strategy: 'recent-fallback', baseline_sample_count: selected.length, recent_sample_count: p.sample_count, recent_correction_ratio: 1 } });
      continue;
    }
    const base = median(selected.map(s => s[0]));
    const recentWeight = p ? Math.min(0.8, p.sample_count / (p.sample_count + 12)) * p.confidence : 0;
    const rawRatio = p ? clamp(p.median_seconds / base, 0.5, 2) : 1;
    const correction = 1 + recentWeight * (rawRatio - 1);
    const seconds = Math.round(base * correction);
    const sorted = selected.map(s => s[0]).sort((a, b) => a - b);
    const p25 = sorted[Math.floor((sorted.length - 1) * 0.25)], p75 = sorted[Math.ceil((sorted.length - 1) * 0.75)];
    const confidence = Math.min(0.85, 0.5 * Math.min(1, baseDays / 12) + 0.3 * clamp(1 - (p75 - p25) / base, 0, 1));
    const meta = group.meta;
    profiles.push({
      segment_key: meta.segment_key, route_id: meta.route_id, direction_id: String(meta.direction_id ?? ''),
      from_stop_id: meta.from_stop_id, to_stop_id: meta.to_stop_id, day_type: meta.day_type, time_bin: meta.time_bin,
      profile_seconds: seconds, median_seconds: seconds,
      p25_seconds: Math.round(Math.min(seconds, p25 * correction, p?.p25_seconds ?? Infinity)),
      p75_seconds: Math.round(Math.max(seconds, p75 * correction, p?.p75_seconds ?? 0)),
      mad_seconds: Math.round(Math.max(median(selected.map(s => Math.abs(s[0] - base))) * correction, p?.mad_seconds || 0)),
      sample_count: selected.length, confidence: Math.min(confidence, p?.confidence ?? confidence), generated_at: new Date(nowMs).toISOString(),
      history: { strategy: hasPriorYear && selected === seasonal ? 'seasonal-baseline' : 'historical-baseline', baseline_seconds: base, baseline_sample_count: selected.length, baseline_distinct_dates: baseDays, recent_sample_count: p?.sample_count || 0, recent_correction_ratio: correction, recent_weight: recentWeight },
    });
  }
  // Leave current weather/traffic correction behavior unchanged. Seasonal weather
  // conditioning requires matched-condition validation before production activation.
  return { profiles, weatherProfiles: recent.weatherProfiles, sourceObjects: dates.size, strategy: 'history-baseline-recent-residual-v1', limitations: ['weather remains recent-28-day', 'no historic traffic or timetable-version matching', 'confidence is not calibrated accuracy'] };
}

// Contract for future supervised learning. Call at prediction time, join outcomes
// later by prediction_id; never backfill inputs using information learned afterward.
export function predictionExample(input) {
  const { prediction_id, predicted_at, target_at, segment_key, generation, timetable_version, predicted_seconds, features } = input;
  if (!prediction_id || !segment_key || !generation || !Number.isFinite(Date.parse(predicted_at)) || !Number.isFinite(Date.parse(target_at)) || !Number.isFinite(predicted_seconds) || predicted_seconds <= 0) throw Error('Invalid prediction example');
  if (Date.parse(target_at) < Date.parse(predicted_at)) throw Error('Prediction target is in the past');
  for (const value of Object.values(features || {})) {
    if (value != null && (!value.observed_at || !Number.isFinite(Date.parse(value.observed_at)) || Date.parse(value.observed_at) > Date.parse(predicted_at))) throw Error('Future or undated feature');
  }
  return { version: 1, kind: 'prediction-input', prediction_id, predicted_at, target_at, segment_key, generation, timetable_version: timetable_version || null, predicted_seconds, features: structuredClone(features || {}) };
}
