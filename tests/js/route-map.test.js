import test from "node:test";
import assert from "node:assert/strict";
import { buildRoutePatterns, coordinatesForPattern, isValidRouteFile } from "../../js/route-map-model.js";

const routeData = {
  stops: { a: { lat: 35, lon: 139 }, b: { lat: 35.1, lon: 139.1 }, c: { lat: 35.2, lon: 139.2 } },
  trips: [
    { direction_id: "0", headsign: "東口", shape_id: "s1", stop_times: [["a"], ["b"], ["c"]] },
    { direction_id: "0", headsign: "東口", shape_id: "s1", stop_times: [["a"], ["b"], ["c"]] },
    { direction_id: "1", headsign: "西口", shape_id: "", stop_times: [["c"], ["a"]] },
  ],
  shapes: { s1: [[35.01, 139.01], [35.11, 139.11]] },
};

test("route file path is restricted to generated route data", () => {
  assert.equal(isValidRouteFile("routes/route-0123456789abcdef.json"), true);
  assert.equal(isValidRouteFile("../secrets.json"), false);
});

test("patterns are filtered and duplicate scheduled trips are combined", () => {
  const patterns = buildRoutePatterns(routeData, { directionId: "0", headsign: "東口" });
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].tripCount, 2);
  assert.deepEqual(patterns[0].stopIds, ["a", "b", "c"]);
});

test("GTFS shape is preferred and stop coordinates are the fallback", () => {
  const east = buildRoutePatterns(routeData, { directionId: "0" })[0];
  assert.deepEqual(coordinatesForPattern(routeData, east), {
    coordinates: [[35.01, 139.01], [35.11, 139.11]], exactShape: true,
  });
  const west = buildRoutePatterns(routeData, { directionId: "1" })[0];
  assert.deepEqual(coordinatesForPattern(routeData, west), {
    coordinates: [[35.2, 139.2], [35, 139]], exactShape: false,
  });
});
