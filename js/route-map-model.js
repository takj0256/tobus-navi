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
    const key = `${trip.shape_id || ""}|${stopIds.join(">")}`;
    const current = patterns.get(key);
    if (current) {
      current.tripCount += 1;
      continue;
    }
    patterns.set(key, {
      key,
      shapeId: trip.shape_id || "",
      headsign: trip.headsign || "",
      directionId: String(trip.direction_id || ""),
      stopIds,
      tripCount: 1,
    });
  }
  return [...patterns.values()].sort((a, b) => b.tripCount - a.tripCount || b.stopIds.length - a.stopIds.length);
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

function validCoordinate(value) {
  return Array.isArray(value)
    && Number.isFinite(Number(value[0]))
    && Number.isFinite(Number(value[1]))
    && Math.abs(Number(value[0])) <= 90
    && Math.abs(Number(value[1])) <= 180;
}
