import { getApproachingVehicles } from "./realtime.js";
import {
  findTripStopIndex,
  getDailyTimetable,
  getUpcomingDepartures,
  tripMatchesSelection,
} from "./timetable.js";

export function routeSelection(stopId, route = {}) {
  return {
    stop_id: stopId,
    headsign: route.headsign || "",
    direction_id: route.direction_id ?? "",
  };
}

export function mergePlatformDepartures(routeEntries, stopId, now = new Date(), limit = 12) {
  return (routeEntries || [])
    .flatMap((entry) => getUpcomingDepartures(
      entry.routeData,
      routeSelection(stopId, entry.route),
      now,
      limit,
    ).map((departure) => ({ ...departure, ...entry })))
    .sort((a, b) => a.departure_ms - b.departure_ms
      || String(a.route.route_name || "").localeCompare(String(b.route.route_name || ""), "ja"))
    .slice(0, limit);
}

export function mergePlatformTimetable(routeEntries, stopId, serviceDate) {
  return (routeEntries || []).map((entry) => ({
    ...entry,
    departures: getDailyTimetable(
      entry.routeData,
      routeSelection(stopId, entry.route),
      serviceDate,
    ),
  })).filter((entry) => entry.departures.length > 0);
}

export function mergePlatformVehicles(routeEntries, stopId, feed, nowMs = Date.now(), options = {}) {
  const seen = new Set();
  const merged = [];

  for (const entry of routeEntries || []) {
    const vehicles = getApproachingVehicles(
      entry.routeData,
      routeSelection(stopId, entry.route),
      feed,
      nowMs,
      options,
    );
    for (const item of vehicles) {
      const key = combinedVehicleKey({ ...item, routeKey: entry.routeKey });
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...item, ...entry, combinedVehicleId: key });
    }
  }

  return merged.sort((a, b) => a.targetEtaMs - b.targetEtaMs
    || String(a.route.route_name || "").localeCompare(String(b.route.route_name || ""), "ja"));
}

export function combinedVehicleKey(item) {
  const base = item?.vehicle?.vehicle?.id
    || item?.vehicle?.entityId
    || `${item?.vehicle?.trip?.tripId || "trip"}-${item?.vehicle?.currentStopSequence ?? "seq"}`;
  return `${item?.routeKey || "route"}::${base}`;
}

export function buildApproachLanes(routeEntries, vehicles, stopId, maxStops = 7) {
  return (routeEntries || []).map((entry) => {
    const routeVehicles = (vehicles || []).filter((item) => item.routeKey === entry.routeKey);
    const trip = routeVehicles[0]?.trip || findRepresentativeTrip(entry, stopId);
    if (!trip) return null;

    const targetIndex = findTripStopIndex(trip, stopId);
    if (targetIndex < 0) return null;
    const startIndex = Math.max(0, targetIndex - Math.max(1, maxStops - 1));
    const stopTimes = trip.stop_times.slice(startIndex, targetIndex + 1).reverse();
    const stops = stopTimes.map((stopTime, laneIndex) => {
      const stop = entry.routeData.stops?.[stopTime[0]] || {};
      return {
        stop_id: stopTime[0],
        stop_name: stop.stop_name || stopTime[0],
        platform_code: stop.platform_code || "",
        lane_index: laneIndex,
        is_target: laneIndex === 0,
      };
    });

    const markers = routeVehicles.map((item) => {
      const rawIndex = Math.max(0, Number(item.stopsAway || 0));
      const progress = Number.isFinite(Number(item.segmentProgress)) ? Number(item.segmentProgress) : 1;
      const segmentOffset = item.vehicle?.currentStatus === 1 ? 0 : Math.max(0, Math.min(0.98, 1 - progress));
      return {
        vehicle_id: item.combinedVehicleId || combinedVehicleKey(item),
        lane_index: Math.min(rawIndex, Math.max(0, stops.length - 1)),
        segment_offset: segmentOffset,
        segment_progress: progress,
        is_overflow: rawIndex + segmentOffset >= stops.length,
        minutes: item.minutes,
        eta_label: item.etaLabel,
        correction_label: item.correctionLabel,
        current_label: item.currentLabel,
        vehicle_label: item.vehicle?.vehicle?.label || item.vehicle?.vehicle?.id || "バス",
      };
    });

    return {
      ...entry,
      trip,
      stops,
      markers,
      hidden_stop_count: Math.max(0, targetIndex + 1 - stops.length),
    };
  }).filter(Boolean);
}

function findRepresentativeTrip(entry, stopId) {
  const selection = routeSelection(stopId, entry.route);
  return (entry.routeData?.trips || []).find((trip) => (
    tripMatchesSelection(trip, selection) && findTripStopIndex(trip, stopId) >= 0
  ));
}
