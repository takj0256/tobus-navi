const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAY_INDEX = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 0: 6 };

export function tokyoDateParts(date = new Date()) {
  const shifted = new Date(date.getTime() + TOKYO_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

export function dateKeyFromParts(parts) {
  return `${String(parts.year).padStart(4, "0")}${String(parts.month).padStart(2, "0")}${String(parts.day).padStart(2, "0")}`;
}

export function addServiceDays(dateKey, days) {
  const { year, month, day } = parseDateKey(dateKey);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function currentTokyoDateKey(now = new Date()) {
  return dateKeyFromParts(tokyoDateParts(now));
}

export function serviceDayStartMs(dateKey) {
  const { year, month, day } = parseDateKey(dateKey);
  return Date.UTC(year, month - 1, day) - TOKYO_OFFSET_MS;
}

export function scheduledTimestampMs(dateKey, secondsFromMidnight) {
  return serviceDayStartMs(dateKey) + Number(secondsFromMidnight) * 1000;
}

export function isServiceActive(serviceId, dateKey, services = {}) {
  const exception = services.exceptions?.[dateKey];
  if (exception?.remove?.includes(serviceId)) return false;
  if (exception?.add?.includes(serviceId)) return true;

  const calendar = services.calendars?.[serviceId];
  if (!calendar) return false;
  if (calendar.start_date && dateKey < calendar.start_date) return false;
  if (calendar.end_date && dateKey > calendar.end_date) return false;

  const { year, month, day } = parseDateKey(dateKey);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const calendarIndex = WEEKDAY_INDEX[weekday];
  return Number(calendar.weekdays?.[calendarIndex] || 0) === 1;
}

export function tripMatchesSelection(trip, selection) {
  if (!trip || !selection) return false;
  if (selection.direction_id !== undefined && selection.direction_id !== null && selection.direction_id !== "") {
    if (String(trip.direction_id) !== String(selection.direction_id)) return false;
  }
  if (selection.headsign && trip.headsign !== selection.headsign) return false;
  return trip.stop_times?.some((stopTime) => stopTime[0] === selection.stop_id) || false;
}

export function findTripStopIndex(trip, stopId) {
  return (trip?.stop_times || []).findIndex((stopTime) => stopTime[0] === stopId);
}

export function getUpcomingDepartures(routeData, selection, now = new Date(), limit = 12) {
  const today = currentTokyoDateKey(now);
  const serviceDates = [addServiceDays(today, -1), today, addServiceDays(today, 1)];
  const minimumMs = now.getTime() - 60 * 1000;
  const maximumMs = now.getTime() + 30 * 60 * 60 * 1000;
  const departures = [];

  for (const trip of routeData.trips || []) {
    if (!tripMatchesSelection(trip, selection)) continue;
    const stopIndex = findTripStopIndex(trip, selection.stop_id);
    if (stopIndex < 0) continue;
    const stopTime = trip.stop_times[stopIndex];

    for (const serviceDate of serviceDates) {
      if (!isServiceActive(trip.service_id, serviceDate, routeData.services)) continue;
      const departureMs = scheduledTimestampMs(serviceDate, stopTime[2]);
      if (departureMs < minimumMs || departureMs > maximumMs) continue;
      departures.push({
        trip,
        trip_id: trip.trip_id,
        service_date: serviceDate,
        departure_ms: departureMs,
        scheduled_seconds: stopTime[2],
        stop_index: stopIndex,
      });
    }
  }

  return departures
    .sort((a, b) => a.departure_ms - b.departure_ms || a.trip_id.localeCompare(b.trip_id))
    .slice(0, limit);
}

export function getDailyTimetable(routeData, selection, serviceDate = currentTokyoDateKey(), limit = 200) {
  const departures = [];
  for (const trip of routeData.trips || []) {
    if (!tripMatchesSelection(trip, selection)) continue;
    if (!isServiceActive(trip.service_id, serviceDate, routeData.services)) continue;
    const stopIndex = findTripStopIndex(trip, selection.stop_id);
    if (stopIndex < 0) continue;
    const stopTime = trip.stop_times[stopIndex];
    departures.push({
      trip_id: trip.trip_id,
      headsign: trip.headsign,
      direction_id: trip.direction_id,
      service_date: serviceDate,
      departure_ms: scheduledTimestampMs(serviceDate, stopTime[2]),
      scheduled_seconds: stopTime[2],
      stop_index: stopIndex,
    });
  }
  return departures.sort((a, b) => a.scheduled_seconds - b.scheduled_seconds).slice(0, limit);
}

export function formatGtfsClock(seconds) {
  if (!Number.isFinite(Number(seconds))) return "--:--";
  const total = Number(seconds);
  const hours = Math.floor(total / 3600) % 24;
  const minutes = Math.floor((total % 3600) / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function formatTimestampClock(timestampMs) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestampMs));
}

export function minutesUntil(timestampMs, nowMs = Date.now()) {
  return Math.max(0, Math.ceil((timestampMs - nowMs) / 60_000));
}

export function findBestServiceDateForVehicle(trip, routeData, vehicleTimestampMs, descriptorStartDate = "") {
  if (/^\d{8}$/.test(descriptorStartDate)) return descriptorStartDate;
  const today = currentTokyoDateKey(new Date(vehicleTimestampMs));
  const candidates = [addServiceDays(today, -1), today, addServiceDays(today, 1)]
    .filter((dateKey) => isServiceActive(trip.service_id, dateKey, routeData.services));
  if (!candidates.length) return today;

  const firstDeparture = trip.stop_times?.[0]?.[2] ?? 0;
  return candidates
    .map((dateKey) => ({ dateKey, distance: Math.abs(scheduledTimestampMs(dateKey, firstDeparture) - vehicleTimestampMs) }))
    .sort((a, b) => a.distance - b.distance)[0].dateKey;
}

function parseDateKey(dateKey) {
  const value = String(dateKey || "");
  if (!/^\d{8}$/.test(value)) throw new Error(`日付形式が正しくありません: ${value}`);
  return {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(4, 6)),
    day: Number(value.slice(6, 8)),
  };
}
