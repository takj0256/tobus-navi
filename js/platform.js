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

// Build actual paths first, then share physical stop IDs without losing branches.
export function buildPlatformApproachBoard(routeEntries, vehicles, stopId, maxStops = 7) {
  const nodes = new Map();
  const markers = [];
  const seenVehicles = new Set();
  const limit = Math.max(1, Math.floor(Number(maxStops) || 7));
  let hiddenStopCount = 0;

  for (const entry of routeEntries || []) {
    const routeVehicles = (vehicles || []).filter((item) => item.routeKey === entry.routeKey);
    const paths = routeVehicles.length
      ? routeVehicles.map((item) => ({ trip: item.trip, item }))
      : [{ trip: findRepresentativeTrip(entry, stopId), item: null }];
    for (const { trip, item } of paths) {
      if (!trip) continue;
      const targetIndex = Number.isInteger(item?.targetIndex) && trip.stop_times[item.targetIndex]?.[0] === stopId
        ? item.targetIndex : findTripStopIndex(trip, stopId);
      if (targetIndex < 0) continue;
      const path = trip.stop_times.slice(Math.max(0, targetIndex - limit + 1), targetIndex + 1).reverse();
      const nodeIds = path.map((_, index) => JSON.stringify(path.slice(0, index + 1).map((time) => time[0])));
      hiddenStopCount = Math.max(hiddenStopCount, targetIndex + 1 - path.length);
      path.forEach((time, index) => {
        const stop = entry.routeData.stops?.[time[0]] || {};
        if (!nodes.has(nodeIds[index])) nodes.set(nodeIds[index], {
          node_id: nodeIds[index],
          downstream_node_id: nodeIds[index - 1] || null,
          stop_id: time[0],
          stop_name: stop.stop_name || time[0],
          platform_code: stop.platform_code || "",
          lane_index: index,
          is_target: index === 0,
        });
      });
      if (!item) continue;
      const vehicleId = item.combinedVehicleId || combinedVehicleKey(item);
      if (seenVehicles.has(vehicleId)) continue;
      seenVehicles.add(vehicleId);
      // Attach moving buses to the last observed stop; the next-stop distance
      // can be zero while the bus is still travelling toward this platform.
      const distance = Number.isInteger(item.currentIndex) && item.currentIndex >= 0 && item.currentIndex <= targetIndex
        ? targetIndex - item.currentIndex : Math.max(0, Number(item.stopsAway) || 0);
      const index = Math.min(Math.floor(distance), path.length - 1);
      const progress = Number.isFinite(Number(item.segmentProgress)) ? Number(item.segmentProgress) : 1;
      const offset = item.vehicle?.currentStatus === 1 ? 0 : Math.max(0, Math.min(0.98, 1 - progress));
      markers.push({
        vehicle_id: vehicleId,
        node_id: nodeIds[index],
        lane_index: index,
        segment_progress: progress,
        segment_offset: offset,
        is_moving: Number.isInteger(item.nextIndex) && Number.isInteger(item.currentIndex) && item.nextIndex > item.currentIndex,
        is_overflow: distance + offset >= path.length,
        stops_away: distance,
        minutes: item.minutes,
        eta_label: item.etaLabel,
        current_label: item.currentLabel,
        vehicle_label: item.vehicle?.vehicle?.label || item.vehicle?.vehicle?.id || "バス",
        route_name: entry.route.route_name || "系統",
        headsign: item.trip?.headsign || entry.route.headsign || "",
      });
    }
  }
  const stops = mergeSharedApproachStops(nodes, markers);
  return {
    stops,
    markers,
    columns: Array.from({ length: Math.max(0, ...stops.map((stop) => stop.lane_index + 1)) }, (_, index) => (
      stops.filter((stop) => stop.lane_index === index)
    )),
    hidden_stop_count: hiddenStopCount,
  };
}

function mergeSharedApproachStops(nodes, markers) {
  // Count reverse visits so a circular route does not merge its first and
  // second visit. Names and ordinal distance alone are never an identity.
  const ids = new Map([...nodes].map(([id, stop]) => [id, JSON.stringify([
    stop.stop_id, JSON.parse(id).filter((value) => value === stop.stop_id).length,
  ])]));
  const merged = new Map();
  for (const [id, stop] of nodes) {
    const key = ids.get(id);
    if (!merged.has(key)) merged.set(key, { ...stop, node_id: key, downstream_node_ids: [] });
    const next = ids.get(stop.downstream_node_id);
    const links = merged.get(key).downstream_node_ids;
    if (next && !links.includes(next)) links.push(next);
  }
  const depths = new Map();
  const visiting = new Set();
  function depth(id) {
    if (depths.has(id)) return depths.get(id);
    if (visiting.has(id)) return null;
    visiting.add(id);
    const downstream = merged.get(id).downstream_node_ids.map(depth);
    visiting.delete(id);
    if (downstream.includes(null)) return null;
    const value = downstream.length ? Math.max(...downstream) + 1 : 0;
    depths.set(id, value);
    return value;
  }
  // Opposite ordering across different trips can form a cycle. In that rare
  // case retain unambiguous path-specific nodes rather than invent an order.
  if ([...merged.keys()].some((id) => depth(id) === null)) {
    return [...nodes.values()].map((stop) => ({ ...stop, downstream_node_ids: stop.downstream_node_id ? [stop.downstream_node_id] : [] }));
  }
  for (const stop of merged.values()) {
    stop.lane_index = depths.get(stop.node_id);
    stop.downstream_node_id = stop.downstream_node_ids.length === 1 ? stop.downstream_node_ids[0] : null;
  }
  for (const marker of markers) {
    marker.node_id = ids.get(marker.node_id);
    marker.lane_index = depths.get(marker.node_id);
  }
  return [...merged.values()];
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
