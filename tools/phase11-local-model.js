import { buildWeatherAdjustmentProfile, buildWeeklyProfile } from "../js/phase11.js";

export function buildLocalProfiles(payloads, nowMs = Date.now()) {
  const cutoff = nowMs - 28 * 86_400_000;
  const groups = new Map();
  for (const payload of payloads || []) {
    for (const compact of payload?.groups || []) {
      const key = `${compact.segment_key}|${compact.day_type}|${compact.time_bin}`;
      const samples = groups.get(key) || [];
      for (const value of compact.samples || []) {
        const seconds = Number(value[0]);
        const timestampMs = Number(value[1]);
        if (!Number.isFinite(seconds) || !Number.isFinite(timestampMs) || timestampMs < cutoff) continue;
        samples.push({
          seconds, timestampMs, anomalous: false, event: compact,
          weatherClass: value[2] || null, temperatureBand: value[3] || null,
        });
      }
      groups.set(key, samples);
    }
  }

  const profiles = [];
  const bases = new Map();
  for (const [key, samples] of groups) {
    if (samples.length < 3) continue;
    const event = samples[0].event;
    const parts = key.split("|");
    const timeBin = parts.pop();
    const dayType = parts.pop();
    const profile = buildWeeklyProfile(samples, median(samples.map((item) => item.seconds)), nowMs);
    if (!profile) continue;
    bases.set(key, { event, profile });
    profiles.push({
      segment_key: event.segment_key, route_id: event.route_id,
      direction_id: String(event.direction_id ?? ""), from_stop_id: event.from_stop_id,
      to_stop_id: event.to_stop_id, day_type: dayType, time_bin: timeBin,
      profile_seconds: profile.median_seconds, ...profile,
    });
  }

  const weatherGroups = new Map();
  const addWeather = (key, metadata, sample) => {
    const group = weatherGroups.get(key) || { ...metadata, samples: [] };
    group.samples.push(sample);
    weatherGroups.set(key, group);
  };
  for (const [key, samples] of groups) {
    const base = bases.get(key);
    if (!base) continue;
    for (const sample of samples) {
      if (!sample.weatherClass || !sample.temperatureBand) continue;
      const value = { ratio: sample.seconds / base.profile.median_seconds, timestampMs: sample.timestampMs };
      const route = String(base.event.route_id || "");
      const direction = String(base.event.direction_id ?? "");
      addWeather(`route|${route}|${direction}|${sample.weatherClass}|${sample.temperatureBand}`, {
        scope: "route", route_id: route, direction_id: direction,
        weather_class: sample.weatherClass, temperature_band: sample.temperatureBand,
      }, value);
      addWeather(`global|${sample.weatherClass}|${sample.temperatureBand}`, {
        scope: "global", route_id: "*", direction_id: "",
        weather_class: sample.weatherClass, temperature_band: sample.temperatureBand,
      }, value);
    }
  }
  const weatherProfiles = [];
  for (const group of weatherGroups.values()) {
    const global = group.scope === "global";
    const profile = buildWeatherAdjustmentProfile(group.samples, nowMs, {
      minimumSamples: global ? 100 : 20, targetSamples: global ? 400 : 80,
    });
    if (profile && profile.confidence >= 0.6) weatherProfiles.push({ ...group, samples: undefined, ...profile });
  }
  return { profiles, weatherProfiles, sourceObjects: payloads.length };
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 60;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
