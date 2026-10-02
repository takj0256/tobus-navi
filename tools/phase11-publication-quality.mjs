// 2026-10-02: publish available observations; predict absent intervals from other days.
export const AVAILABLE_OBSERVATIONS_POLICY = 'available-observations-v1';
export function observedEventsOutsideGaps(events, quality) {
  const gaps = (quality?.missing_raw_keys || []).map(k => Date.parse(`${k.slice(7,17)}T${k.slice(18,20)}:${k.slice(21,23)}:00Z`));
  return events.filter(e => {
    const end = Number(e.timestamp_ms), start = end - Number(e.seconds) * 1000;
    return !gaps.some(t => start < t + 60000 && end >= t);
  });
}
export function qualityFromAudit(day, audit) {
  const start = Date.parse(`${day}T00:00:00+09:00`), end = start + 86400000;
  const monitorStart = Date.parse(audit?.start_at);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(start) ||
      audit?.date_key !== day || audit?.publication_policy !== AVAILABLE_OBSERVATIONS_POLICY ||
      Date.parse(audit.checked_at) < end + 90000 || !Number.isFinite(Date.parse(audit.checked_at)) ||
      !Number.isFinite(monitorStart) || monitorStart >= end ||
      audit.backlog !== 0 || audit.pending_hours !== 0 || !Array.isArray(audit.missing_raw_keys)) {
    throw Error('Complete processing audit required before partial daily publication');
  }
  const keys = [...new Set(audit.missing_raw_keys)].sort();
  if (keys.some(k => {
    if (!/^raw-v1\/\d{4}-\d{2}-\d{2}\/\d{2}\/\d{2}\.pb$/.test(k)) return true;
    const t = Date.parse(`${k.slice(7,17)}T${k.slice(18,20)}:${k.slice(21,23)}:00Z`);
    return !Number.isFinite(t) || t < start || t >= end;
  })) throw Error('Missing capture keys must belong to audited JST day');
  return {
    status: keys.length || monitorStart > start ? 'partial-observations' : 'complete',
    publication_policy: AVAILABLE_OBSERVATIONS_POLICY,
    checked_at: audit.checked_at,
    capture_monitor_start_at: audit.start_at,
    unmonitored_minutes: Math.max(0, Math.ceil((monitorStart - start) / 60000)),
    missing_capture_minutes: keys.length, missing_raw_keys: keys,
    imputed_observations: 0,
    prediction_strategy: 'same-segment-day-type-time-bin-observed-history',
    reason: 'Use available real observations across days; missing intervals add no samples.',
  };
}
