// Cabinet Office official published calendar, checked 2026-10-13.
// https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html
// Do not extrapolate unpublished equinox dates. Update before 2028.
export const JAPAN_HOLIDAY_CALENDAR_VERSION = 'cao-2026-2027-v1';
const officialDateKeys = new Set([
  '2026-01-01', '2026-01-12', '2026-02-11', '2026-02-23',
  '2026-03-20', '2026-04-29', '2026-05-03', '2026-05-04',
  '2026-05-05', '2026-05-06', '2026-07-20', '2026-08-11',
  '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-12',
  '2026-11-03', '2026-11-23',
  '2027-01-01', '2027-01-11', '2027-02-11', '2027-02-23',
  '2027-03-21', '2027-03-22', '2027-04-29', '2027-05-03',
  '2027-05-04', '2027-05-05', '2027-07-19', '2027-08-11',
  '2027-09-20', '2027-09-23', '2027-10-11', '2027-11-03', '2027-11-23',
]);

export function isOfficialJapanHoliday(dateKey) {
  return officialDateKeys.has(dateKey);
}

// Correct only known official holidays; retain explicit/custom stored classes.
// Never mutate observations or manufacture samples while regrouping.
export function officialHolidayDayType(timestampMs, storedDayType) {
  if (!Number.isFinite(timestampMs)) return storedDayType;
  const date = new Date(timestampMs + 9 * 3600000);
  if (!Number.isFinite(date.getTime())) return storedDayType;
  const dateKey = date.toISOString().slice(0, 10);
  return isOfficialJapanHoliday(dateKey) ? 'holiday' : storedDayType;
}
