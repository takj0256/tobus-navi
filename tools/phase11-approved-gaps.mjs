// User-approved on 2026-09-27. Exact historical keys only, never a blanket waiver.
const approved = {
  '2026-09-24': ['raw-v1/2026-09-23/23/59.pb', 'raw-v1/2026-09-24/00/53.pb', 'raw-v1/2026-09-24/00/54.pb', 'raw-v1/2026-09-24/00/55.pb'],
  '2026-09-25': ['raw-v1/2026-09-25/00/48.pb', 'raw-v1/2026-09-25/00/49.pb', 'raw-v1/2026-09-25/04/36.pb', 'raw-v1/2026-09-25/06/09.pb'],
  '2026-09-26': ['raw-v1/2026-09-26/01/54.pb'],
};
export function approvedMissingKeys(day) { return [...(approved[day] || [])]; }
export function unapprovedMissingKeys(day, keys) {
  const allowed = new Set(approvedMissingKeys(day));
  return keys.filter(key => !allowed.has(key));
}
export function dailyQuality(day) {
  const keys = approvedMissingKeys(day);
  return keys.length ? { status: 'incomplete-approved', approval_date: '2026-09-27', missing_capture_minutes: keys.length, missing_raw_keys: keys, imputed_observations: 0, reason: 'Original observations unavailable; publish remaining observations with disclosed gaps.' } : undefined;
}
export function summarizeInputQuality(payloads) {
  const days = payloads.filter(p => ['incomplete-approved', 'partial-observations'].includes(p.data_quality?.status)).map(p => ({ date: p.date_key, ...p.data_quality }));
  return days.length ? { status: days.some(d => d.status === 'partial-observations') ? 'contains-partial-observations' : 'contains-incomplete-approved-days', missing_capture_minutes: days.reduce((s, d) => s + d.missing_capture_minutes, 0), late_capture_minutes: days.reduce((s, d) => s + (d.late_capture_minutes || 0), 0), imputed_observations: 0, days } : undefined;
}
