import { estimateVehicleProgress } from "./realtime.js";
import { formatTimestampClock } from "./timetable.js";

export function isValidRouteFile(value) {
  return /^routes\/route-[a-f0-9]{16}\.json$/.test(String(value || ""));
}

export function buildRoutePatterns(routeData, { directionId = "", headsign = "" } = {}) {
  const allTrips = Array.isArray(routeData?.trips) ? routeData.trips : [];
  let trips = allTrips.filter((trip) => !directionId || String(trip.direction_id) === String(directionId));
  const exactHeadsign = trips.filter((trip) => !headsign || trip.headsign === headsign);
  if (exactHeadsign.length) trips = exactHeadsign;
  if (!trips.length) trips = allTrips;

  const patterns = new Map();
  for (const trip of trips) {
    const stopIds = (trip.stop_times || []).map((item) => item[0]).filter(Boolean);
    if (stopIds.length < 2) continue;
    const key = routePatternKey(trip, stopIds);
    const current = patterns.get(key);
    if (current) {
      current.tripCount += 1;
      continue;
    }
    patterns.set(key, {
      key,
      shapeId: trip.shape_id || "",
      headsign: trip.headsign || "",
      directionId: String(trip.direction_id ?? ""),
      stopIds,
      tripCount: 1,
    });
  }
  return [...patterns.values()].sort((a, b) => b.tripCount - a.tripCount || b.stopIds.length - a.stopIds.length);
}

export function buildRoutePatternGroups(patterns) {
  const groups = new Map();
  for (const pattern of patterns || []) {
    const key = `${pattern.directionId}|${pattern.headsign}`;
    if (!groups.has(key)) groups.set(key, { key, directionId: pattern.directionId, headsign: pattern.headsign, patterns: [] });
    groups.get(key).patterns.push(pattern);
  }
  return [...groups.values()].sort((a, b) => {
    const aTrips = a.patterns.reduce((sum, pattern) => sum + pattern.tripCount, 0);
    const bTrips = b.patterns.reduce((sum, pattern) => sum + pattern.tripCount, 0);
    return bTrips - aTrips;
  });
}

export function buildRouteNetwork(routeData, patterns) {
  const ordered = [...(patterns || [])].sort((a, b) => b.stopIds.length - a.stopIds.length || b.tripCount - a.tripCount);
  const primary = ordered[0];
  if (!primary) return null;
  const primaryResult = coordinatesForPattern(routeData, primary);
  const lines = [{
    pattern: primary,
    role: "primary",
    color: "#d53838",
    origin: stopName(routeData, primary.stopIds[0]),
    mergeStopId: "",
    coordinates: primaryResult.coordinates,
    exactShape: primaryResult.exactShape,
  }];
  const branchColors = ["#1769aa", "#16845b", "#7a4db3", "#d06a18"];
  let branchColorIndex = 0;
  for (const pattern of ordered.slice(1)) {
    const sharedLength = commonSuffixLength(primary.stopIds, pattern.stopIds);
    const mergeIndex = sharedLength > 0 ? pattern.stopIds.length - sharedLength : pattern.stopIds.length - 1;
    // 本線の途中から始まる区間便は新しい線を重ねず、同じ本線として扱う。
    if (sharedLength === pattern.stopIds.length || mergeIndex <= 0) continue;
    const mergeStopId = sharedLength > 0 ? pattern.stopIds[mergeIndex] : "";
    const result = coordinatesUntilStop(routeData, pattern, mergeIndex);
    if (result.coordinates.length < 2) continue;
    lines.push({
      pattern,
      role: "branch",
      color: branchColors[branchColorIndex % branchColors.length],
      origin: stopName(routeData, pattern.stopIds[0]),
      mergeStopId,
      coordinates: result.coordinates,
      exactShape: result.exactShape,
    });
    branchColorIndex += 1;
  }
  const uniqueStopIds = new Set(ordered.flatMap((pattern) => pattern.stopIds));
  return {
    primary,
    patterns: ordered,
    lines,
    destination: primary.headsign || stopName(routeData, primary.stopIds[primary.stopIds.length - 1]),
    primaryStopCount: primary.stopIds.length,
    totalStopCount: uniqueStopIds.size,
  };
}

export function coordinatesForPattern(routeData, pattern) {
  const shape = routeData?.shapes?.[pattern?.shapeId];
  if (Array.isArray(shape) && shape.length >= 2) {
    const coordinates = shape.filter(validCoordinate).map(([lat, lon]) => [Number(lat), Number(lon)]);
    if (coordinates.length >= 2) return { coordinates, exactShape: true };
  }
  const coordinates = (pattern?.stopIds || [])
    .map((stopId) => routeData?.stops?.[stopId])
    .filter((stop) => validCoordinate([stop?.lat, stop?.lon]))
    .map((stop) => [Number(stop.lat), Number(stop.lon)]);
  return { coordinates, exactShape: false };
}

export function describeRoutePattern(routeData, pattern) {
  const stopIds = pattern?.stopIds || [];
  const firstStop = routeData?.stops?.[stopIds[0]];
  const lastStop = routeData?.stops?.[stopIds[stopIds.length - 1]];
  const origin = firstStop?.stop_name || "始点不明";
  const destination = pattern?.headsign || lastStop?.stop_name || "行き先不明";
  return {
    origin,
    destination,
    stopCount: stopIds.length,
    selectorLabel: `${origin} → ${destination}（${stopIds.length}停留所）`,
    subtitle: `始点：${origin} ／ ${destination}方面 ／ ${stopIds.length}停留所`,
  };
}

export function tripMatchesRoutePattern(trip, pattern) {
  const stopIds = (trip?.stop_times || []).map((item) => item[0]).filter(Boolean);
  if (stopIds.length < 2 || !pattern) return false;
  return routePatternKey(trip, stopIds) === pattern.key;
}

function routePatternKey(trip, stopIds) {
  return JSON.stringify([String(trip.direction_id ?? ""), trip.headsign || "", trip.shape_id || "", stopIds]);
}

// 同名停留所や反対側の乗り場を混ぜず、同じstop_idの路線ファイルだけを読む。
export function sharedPlatformRouteFiles(dataset, stopId, primaryFile) {
  const files = new Set(isValidRouteFile(primaryFile) ? [primaryFile] : []);
  if (!stopId) return [...files];
  for (const group of dataset?.stop_groups || []) {
    for (const platform of group.platforms || []) {
      if (platform.stop_id !== stopId) continue;
      for (const route of platform.routes || []) {
        if (isValidRouteFile(route.route_file)) files.add(route.route_file);
      }
    }
  }
  return [...files];
}

export function buildMapRouteEntries(loadedRoutes, { primaryFile, stopId = "" } = {}) {
  return loadedRoutes.flatMap(({ routeFile, routeData }) => {
    // 選択系統は全方面。追加系統はこの乗り場を実際に使う便だけ。
    const trips = (routeData.trips || []).filter((trip) => routeFile === primaryFile
      || (stopId && (trip.stop_times || []).some((stop) => stop[0] === stopId)));
    const patterns = buildRoutePatterns({ ...routeData, trips });
    if (!patterns.length) return [];
    return [{ routeFile, routeData, allowUnmatchedPosition: routeFile === primaryFile,
      trips: new Map(trips.map((trip) => [trip.trip_id, trip])),
      patterns, groups: buildRoutePatternGroups(patterns) }];
  });
}

export function selectMapVehicles(entries, feed, { nowMs = Date.now(), maxAgeMs = 300_000 } = {}) {
  const result = { vehicles: [], unmatchedTrips: 0, observedPositions: 0, unlocated: 0, stale: 0 };
  const seen = new Set();
  const timestamp = (vehicle) => Number(vehicle.timestamp || feed?.timestamp || 0) * 1000;
  const candidates = [...(feed?.vehicles || [])].sort((a, b) => timestamp(b) - timestamp(a));
  for (const vehicle of candidates) {
    const key = vehicle.vehicle?.id || vehicle.entityId;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    const routeId = vehicle.trip?.routeId;
    const entry = entries.find((item) => (!routeId || String(item.routeData.route?.route_id) === String(routeId))
      && item.trips.has(vehicle.trip?.tripId));
    // 対象系統の未照合便は「走行車両なし」へ黙って落とさない。
    const related = entry || (routeId && entries.some((item) => String(item.routeData.route?.route_id) === String(routeId)));
    if (!related) continue;
    const time = timestamp(vehicle);
    if (!Number.isFinite(time) || time <= 0 || nowMs - time > maxAgeMs || time - nowMs > 60_000) {
      result.stale += 1;
      continue;
    }
    if (!entry) {
      // 静的データにはあるが乗り場/方面の対象外の便と、未知の便を区別する。
      const known = entries.some((item) => (item.routeData.trips || []).some((trip) => trip.trip_id === vehicle.trip?.tripId));
      if (!known) {
        result.unmatchedTrips += 1;
        const primaryEntry = entries.find((item) => item.allowUnmatchedPosition
          && String(item.routeData.route?.route_id) === String(routeId));
        const coordinate = [vehicle.position?.latitude, vehicle.position?.longitude];
        // 配信で系統が確定した選択系統だけ。行き先や共有乗り場の通過は推測しない。
        if (primaryEntry && coordinate.every(Number.isFinite) && validCoordinate(coordinate)) {
          result.observedPositions += 1;
          result.vehicles.push({ vehicle, entry: primaryEntry, coordinate,
            routeName: primaryEntry.routeData.route?.route_name || "都バス", headsign: "行き先未照合",
            observedOnly: true, estimate: { currentLabel: "配信位置（停留所イベント・経路未照合）",
              updatedAt: formatTimestampClock(time) } });
        }
      }
      continue;
    }
    const trip = entry.trips.get(vehicle.trip.tripId);
    const pattern = entry.patterns.find((item) => tripMatchesRoutePattern(trip, item));
    if (!pattern) continue; // 明示的な方面フィルタの対象外
    const estimate = estimateVehicleProgress({ ...vehicle, timestamp: time / 1000 }, trip, entry.routeData,
      pattern.stopIds.at(-1), nowMs);
    const coordinate = estimate && coordinateForVehicleEstimate(entry.routeData, pattern, estimate);
    if (!coordinate) { result.unlocated += 1; continue; }
    result.vehicles.push({ vehicle, trip, entry, estimate, coordinate,
      routeName: entry.routeData.route?.route_name || "都バス", headsign: trip.headsign || pattern.headsign || "行き先不明" });
  }
  return result;
}

export function mapMarkerOffset(index) {
  // 6台ごとに同じ位置へ戻る旧オフセットを廃止。全台は一覧からも選べる。
  if (!index) return [0, 0];
  const pair = Math.ceil(index / 2);
  const row = Math.ceil(pair / 2) * (pair % 2 ? 1 : -1);
  return [index % 2 ? -65 : 65, row * 48];
}

export function coordinateForVehicleEstimate(routeData, pattern, estimate) {
  const previousIndex = Number(estimate?.previousIndex);
  const nextIndex = Number(estimate?.nextIndex);
  const progress = Math.max(0, Math.min(1, Number(estimate?.segmentProgress) || 0));
  if (!Number.isInteger(previousIndex) || !Number.isInteger(nextIndex)) return null;

  const previousStop = stopCoordinate(routeData, pattern?.stopIds?.[previousIndex]);
  const nextStop = stopCoordinate(routeData, pattern?.stopIds?.[nextIndex]);
  if (!previousStop || !nextStop) return null;
  if (previousIndex === nextIndex) return previousStop;

  const shape = (routeData?.shapes?.[pattern?.shapeId] || []).filter(validCoordinate);
  if (shape.length >= 2) {
    const projectedIndexes = projectPatternStopsToShape(routeData, pattern, shape);
    const shapeStart = projectedIndexes[previousIndex];
    const shapeEnd = projectedIndexes[nextIndex];
    if (Number.isInteger(shapeStart) && Number.isInteger(shapeEnd) && shapeEnd > shapeStart) {
      return coordinateAlongLine(shape.slice(shapeStart, shapeEnd + 1), progress);
    }
  }
  return interpolateCoordinate(previousStop, nextStop, progress);
}

function projectPatternStopsToShape(routeData, pattern, shape) {
  let minimumIndex = 0;
  return (pattern?.stopIds || []).map((stopId) => {
    const coordinate = stopCoordinate(routeData, stopId);
    if (!coordinate) return minimumIndex;
    let bestIndex = minimumIndex;
    let bestDistance = Infinity;
    for (let index = minimumIndex; index < shape.length; index += 1) {
      const latDifference = Number(shape[index][0]) - coordinate[0];
      const lonDifference = Number(shape[index][1]) - coordinate[1];
      const distance = latDifference * latDifference + lonDifference * lonDifference;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    minimumIndex = bestIndex;
    return bestIndex;
  });
}

function coordinatesUntilStop(routeData, pattern, stopIndex) {
  const shape = (routeData?.shapes?.[pattern?.shapeId] || []).filter(validCoordinate);
  if (shape.length >= 2) {
    const projectedIndexes = projectPatternStopsToShape(routeData, pattern, shape);
    const endIndex = projectedIndexes[stopIndex];
    if (Number.isInteger(endIndex) && endIndex > 0) {
      return {
        coordinates: shape.slice(0, endIndex + 1).map(([lat, lon]) => [Number(lat), Number(lon)]),
        exactShape: true,
      };
    }
  }
  return {
    coordinates: pattern.stopIds.slice(0, stopIndex + 1).map((stopId) => stopCoordinate(routeData, stopId)).filter(Boolean),
    exactShape: false,
  };
}

function commonSuffixLength(left, right) {
  let length = 0;
  while (length < left.length && length < right.length) {
    if (left[left.length - 1 - length] !== right[right.length - 1 - length]) break;
    length += 1;
  }
  return length;
}

function stopName(routeData, stopId) {
  return routeData?.stops?.[stopId]?.stop_name || stopId || "不明";
}

function coordinateAlongLine(line, progress) {
  const lengths = [];
  let total = 0;
  for (let index = 1; index < line.length; index += 1) {
    const length = approximateDistance(line[index - 1], line[index]);
    lengths.push(length);
    total += length;
  }
  if (total <= 0) return [Number(line[0][0]), Number(line[0][1])];
  const target = total * progress;
  let travelled = 0;
  for (let index = 1; index < line.length; index += 1) {
    const length = lengths[index - 1];
    if (travelled + length >= target) {
      const localProgress = length > 0 ? (target - travelled) / length : 0;
      return interpolateCoordinate(line[index - 1], line[index], localProgress);
    }
    travelled += length;
  }
  const last = line[line.length - 1];
  return [Number(last[0]), Number(last[1])];
}

function stopCoordinate(routeData, stopId) {
  const stop = routeData?.stops?.[stopId];
  const coordinate = [Number(stop?.lat), Number(stop?.lon)];
  return validCoordinate(coordinate) ? coordinate : null;
}

function interpolateCoordinate(from, to, progress) {
  return [
    Number(from[0]) + (Number(to[0]) - Number(from[0])) * progress,
    Number(from[1]) + (Number(to[1]) - Number(from[1])) * progress,
  ];
}

function approximateDistance(from, to) {
  const middleLatitude = ((Number(from[0]) + Number(to[0])) / 2) * Math.PI / 180;
  const lat = (Number(to[0]) - Number(from[0])) * 111_320;
  const lon = (Number(to[1]) - Number(from[1])) * 111_320 * Math.cos(middleLatitude);
  return Math.hypot(lat, lon);
}

function validCoordinate(value) {
  return Array.isArray(value)
    && Number.isFinite(Number(value[0]))
    && Number.isFinite(Number(value[1]))
    && Math.abs(Number(value[0])) <= 90
    && Math.abs(Number(value[1])) <= 180;
}
