const TOKYO_TIME_ZONE = "Asia/Tokyo";

export function phase11SegmentKey(routeId, directionId, fromStopId, toStopId) {
  return `${routeId || "route"}|${directionId ?? ""}|${fromStopId || "?"}>${toStopId || "?"}`;
}

export function phase11TimeBin(timestampMs = Date.now(), minutes = 15) {
  const parts = tokyoParts(timestampMs);
  const size = Math.max(5, Number(minutes) || 15);
  const minute = Math.floor(parts.minute / size) * size;
  return `${String(parts.hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function phase11DayType(timestampMs = Date.now(), holidayDateKeys = new Set()) {
  const parts = tokyoParts(timestampMs);
  const dateKey = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  if (holidayDateKeys?.has?.(dateKey) || parts.weekday === "Sun") return "holiday";
  if (parts.weekday === "Sat") return "saturday";
  return "weekday";
}

export function buildWeeklyProfile(samples, scheduledSeconds, nowMs = Date.now(), options = {}) {
  const maximumAgeMs = Math.max(86_400_000, Number(options.maximumAgeMs ?? 28 * 86_400_000));
  const primaryAgeMs = Math.max(86_400_000, Number(options.primaryAgeMs ?? 7 * 86_400_000));
  const values = (samples || []).filter((sample) => (
    !sample.anomalous
    && Number.isFinite(Number(sample.seconds))
    && Number(sample.seconds) >= 15
    && Number(sample.seconds) <= 1800
    && Number(sample.timestampMs) >= nowMs - maximumAgeMs
  ));
  if (!values.length) return null;

  const primary = values.filter((sample) => Number(sample.timestampMs) >= nowMs - primaryAgeMs);
  const selected = primary.length >= Number(options.minimumSamples ?? 3) ? primary : values;
  const seconds = selected.map((sample) => Number(sample.seconds)).sort((a, b) => a - b);
  const medianSeconds = percentile(seconds, 0.5);
  const p25Seconds = percentile(seconds, 0.25);
  const p75Seconds = percentile(seconds, 0.75);
  const deviations = seconds.map((value) => Math.abs(value - medianSeconds)).sort((a, b) => a - b);
  const madSeconds = percentile(deviations, 0.5);
  const recentCount = selected.filter((sample) => Number(sample.timestampMs) >= nowMs - primaryAgeMs).length;
  const sampleScore = Math.min(1, selected.length / 12);
  const spreadScore = clamp(1 - (p75Seconds - p25Seconds) / Math.max(1, medianSeconds), 0, 1);
  const freshnessScore = recentCount / selected.length;
  const confidence = clamp(0.5 * sampleScore + 0.3 * spreadScore + 0.2 * freshnessScore, 0, 1);
  const scheduled = Math.max(15, Number(scheduledSeconds) || medianSeconds);

  return {
    median_seconds: Math.round(medianSeconds),
    p25_seconds: Math.round(p25Seconds),
    p75_seconds: Math.round(p75Seconds),
    mad_seconds: Math.round(madSeconds),
    sample_count: selected.length,
    scheduled_seconds: Math.round(scheduled),
    profile_ratio: medianSeconds / scheduled,
    confidence,
    generated_at: new Date(nowMs).toISOString(),
  };
}

export function applyWeeklyProfile(scheduledSeconds, profile) {
  const scheduled = Math.max(15, Number(scheduledSeconds) || 60);
  const confidence = clamp(Number(profile?.confidence) || 0, 0, 1);
  if (!profile || confidence < 0.3 || !Number.isFinite(Number(profile.median_seconds))) {
    return { seconds: scheduled, profileWeight: 0, source: "schedule" };
  }
  const observed = clamp(Number(profile.median_seconds), scheduled * 0.5, scheduled * 3);
  const profileWeight = Math.min(0.85, 0.65 * confidence);
  return {
    seconds: scheduled * (1 - profileWeight) + observed * profileWeight,
    profileWeight,
    source: "weekly-profile",
  };
}

export function detectPhase11Anomaly(actualSeconds, expectedSeconds, profile, options = {}) {
  const actual = Number(actualSeconds);
  const expected = Math.max(15, Number(expectedSeconds) || 60);
  const delaySeconds = actual - expected;
  const ratio = actual / expected;
  const madBoundary = Number(profile?.p75_seconds) + 2 * Number(profile?.mad_seconds);
  const candidate = Number.isFinite(actual) && (
    delaySeconds >= Number(options.delaySeconds ?? 120)
    || ratio >= Number(options.segmentRatio ?? 1.5)
    || (Number.isFinite(madBoundary) && actual > madBoundary)
  );
  return {
    candidate,
    critical: candidate && delaySeconds >= Number(options.criticalDelaySeconds ?? 300),
    delaySeconds,
    ratio,
    reasons: [
      delaySeconds >= Number(options.delaySeconds ?? 120) ? "delay" : "",
      ratio >= Number(options.segmentRatio ?? 1.5) ? "ratio" : "",
      Number.isFinite(madBoundary) && actual > madBoundary ? "dispersion" : "",
    ].filter(Boolean),
  };
}

export function confirmPhase11Anomaly(candidate, recentCandidates = [], cachedTraffic = null, options = {}) {
  if (!candidate?.candidate) return { confirmed: false, reason: "normal" };
  if (candidate.critical) return { confirmed: true, reason: "critical" };
  const windowMs = Number(options.windowMs ?? 10 * 60_000);
  const nowMs = Number(options.nowMs ?? Date.now());
  const relevant = (recentCandidates || []).filter((item) => (
    item.candidate
    && Number(item.timestampMs) >= nowMs - windowMs
    && (item.sameVehicleConsecutive || item.sameOrAdjacentSegment)
  ));
  if (relevant.some((item) => item.sameVehicleConsecutive)) {
    return { confirmed: true, reason: "consecutive-segments" };
  }
  const vehicleIds = new Set(relevant.map((item) => item.vehicleId).filter(Boolean));
  if (vehicleIds.size >= Number(options.minimumVehicles ?? 2)) {
    return { confirmed: true, reason: "multiple-vehicles" };
  }
  if (cachedTraffic && Number(cachedTraffic.expires_at_ms) > nowMs && (
    cachedTraffic.road_closed || cachedTraffic.incident || Number(cachedTraffic.traffic_ratio) >= 1.35
  )) {
    return { confirmed: true, reason: "existing-traffic-cache" };
  }
  return { confirmed: false, reason: "unconfirmed" };
}

export function buildCorrectionRatio(apiTraffic, busRatio = NaN) {
  const apiRatio = clamp(Number(apiTraffic?.traffic_ratio) || 1, 0.7, 3);
  const apiConfidence = clamp(Number(apiTraffic?.confidence) || 0, 0, 1);
  const hasBus = Number.isFinite(Number(busRatio));
  let apiWeight = hasBus ? 0.5 : 0.6;
  let busWeight = hasBus ? 0.3 : 0;
  let baselineWeight = hasBus ? 0.2 : 0.4;
  if (apiConfidence < 0.5) {
    const shifted = apiWeight / 2;
    apiWeight -= shifted;
    baselineWeight += shifted;
  }
  return apiWeight * apiRatio
    + busWeight * clamp(Number(busRatio) || 1, 0.7, 3)
    + baselineWeight;
}

export function effectiveCorrectionRatio(correctionRatio, elapsedMinutes, downstreamSegmentCount) {
  const downstream = Math.max(0, Number(downstreamSegmentCount) || 0);
  if (downstream > 2) return 1;
  const timeDecay = clamp(1 - Math.max(0, Number(elapsedMinutes) || 0) / 30, 0, 1);
  const distanceDecay = clamp(1 - downstream / 3, 0, 1);
  return 1 + (clamp(Number(correctionRatio) || 1, 0.7, 3) - 1) * timeDecay * distanceDecay;
}

export async function fetchPhase11Estimates(endpoint, segments, options = {}) {
  if (!endpoint || !Array.isArray(segments) || !segments.length) return new Map();
  const fetchImpl = options.fetchImpl || fetch;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutMs = Number(options.timeoutMs ?? 5000);
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${endpoint.replace(/\/$/, "")}/api/v1/estimates`, {
      method: "POST",
      signal: controller?.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ at: options.at || new Date().toISOString(), segments: segments.slice(0, 120) }),
    });
    if (!response.ok) throw new Error(`Phase 11 API HTTP ${response.status}`);
    const body = await response.json();
    return propagateDownstreamCorrections(
      new Map((body.estimates || []).map((item) => [item.segment_key, item])),
      segments,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function propagateDownstreamCorrections(estimates, segments) {
  const result = new Map(estimates instanceof Map ? estimates : []);
  const paths = new Map();
  for (const segment of segments || []) {
    const pathKey = `${segment.route_id || ""}|${segment.direction_id ?? ""}|${segment.shape_id || ""}`;
    const list = paths.get(pathKey) || [];
    list.push(segment);
    paths.set(pathKey, list);
  }
  for (const list of paths.values()) {
    list.sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
    for (let index = 0; index < list.length; index += 1) {
      const source = result.get(list[index].segment_key);
      if (!source?.correction || source.correction.active === false || source.correction.inherited) continue;
      for (let offset = 1; offset <= 2 && index + offset < list.length; offset += 1) {
        const targetKey = list[index + offset].segment_key;
        const target = result.get(targetKey) || { segment_key: targetKey, profile: null };
        if (target.correction?.active !== true) {
          result.set(targetKey, {
            ...target,
            correction: { ...source.correction, downstream_segment_count: offset, inherited: true },
          });
        }
      }
    }
  }
  return result;
}

function tokyoParts(timestampMs) {
  const values = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: TOKYO_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(new Date(timestampMs))) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), weekday: values.weekday,
  };
}

function percentile(sorted, fraction) {
  if (!sorted.length) return NaN;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
