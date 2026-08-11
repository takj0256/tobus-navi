import {
  buildRoutePatterns,
  buildRoutePatternGroups,
  buildRouteNetwork,
  coordinateForVehicleEstimate,
  describeRoutePattern,
  isValidRouteFile,
  tripMatchesRoutePattern,
} from "./route-map-model.js";
import {
  REALTIME_REFRESH_MS,
  REALTIME_SOURCES,
  REALTIME_TIMEOUT_MS,
  REALTIME_VEHICLE_MAX_AGE_MS,
} from "./config.js";
import {
  estimateVehicleProgress,
  fetchRealtimeVehicles,
  isRealtimeFeedStale,
} from "./realtime.js";
import { formatTimestampClock } from "./timetable.js";
import { classifyVehicleType } from "./vehicle-type.js";

const params = new URLSearchParams(location.search);
const elements = {
  title: document.querySelector("#mapTitle"),
  subtitle: document.querySelector("#mapSubtitle"),
  status: document.querySelector("#mapStatus"),
  busStatus: document.querySelector("#busMapStatus"),
  map: document.querySelector("#routeMap"),
  patternWrap: document.querySelector("#patternWrap"),
  patternSelect: document.querySelector("#patternSelect"),
  legend: document.querySelector("#routeLegend"),
};

let map;
let routeData;
let patterns = [];
let patternGroups = [];
let activeNetwork;
let realtimeFeed;
let realtimeTimer;
let realtimeInFlight = false;
let vehicleMarkers = [];

start();

async function start() {
  const routeFile = params.get("route_file") || "";
  if (!isValidRouteFile(routeFile)) return fail("路線データの指定が正しくありません。");
  if (!window.maplibregl) return fail("地図ライブラリを読み込めませんでした。通信状態を確認してください。");
  try {
    const response = await fetch(`./data/${routeFile}`);
    if (!response.ok) throw new Error(`路線データの取得に失敗しました（${response.status}）`);
    routeData = await response.json();
    patterns = buildRoutePatterns(routeData, {
      directionId: params.get("direction_id") || "",
      headsign: params.get("headsign") || "",
    });
    if (!patterns.length) throw new Error("表示できる停留所列がありません。");
    patternGroups = buildRoutePatternGroups(patterns);
    await initializeMap();
    setupPatternSelector();
    renderPattern(0);
    refreshRealtimeVehicles();
  } catch (error) {
    fail(error.message || "路線図を表示できませんでした。");
  }
}

async function initializeMap() {
  map = new maplibregl.Map({
    container: elements.map,
    style: "https://tiles.openfreemap.org/styles/positron",
    center: [139.767, 35.681],
    zoom: 11,
    attributionControl: true,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error("白地図の準備がタイムアウトしました。")), 12_000);
    // 全タイルの読込完了ではなく、レイヤーを追加できるstyle準備完了を待つ。
    map.once("style.load", () => {
      clearTimeout(timeoutId);
      resolve();
    });
  });

  // 路線確認に不要な建物・住宅地の面を消し、道路と道路名を主役にする。
  for (const layerId of ["building", "landuse_residential"]) {
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", "none");
  }
  map.addSource("route-line", { type: "geojson", data: emptyFeatureCollection() });
  map.addLayer({
    id: "route-line",
    type: "line",
    source: "route-line",
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["case", ["==", ["get", "role"], "primary"], 6, 5],
      "line-opacity": .9,
    },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  map.addSource("route-stops", { type: "geojson", data: emptyFeatureCollection() });
  map.addLayer({
    id: "route-stops",
    type: "circle",
    source: "route-stops",
    paint: {
      "circle-radius": ["case", ["==", ["get", "selected"], true], 8, 5],
      "circle-color": ["case", ["==", ["get", "selected"], true], "#ff9f43", "#0a5ea8"],
      "circle-stroke-color": ["case", ["==", ["get", "selected"], true], "#a43a00", "#ffffff"],
      "circle-stroke-width": ["case", ["==", ["get", "selected"], true], 3, 2],
    },
  });
  map.on("click", "route-stops", showStopPopup);
  map.on("mouseenter", "route-stops", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "route-stops", () => { map.getCanvas().style.cursor = ""; });
}

function setupPatternSelector() {
  elements.patternSelect.replaceChildren(...patternGroups.map((group, index) => {
    const network = buildRouteNetwork(routeData, group.patterns);
    const option = document.createElement("option");
    option.value = String(index);
    const origins = network.lines.map((line) => `${line.origin}発`).join("・");
    option.textContent = `${origins} → ${network.destination}`;
    return option;
  }));
  elements.patternWrap.hidden = patternGroups.length < 2;
  elements.patternSelect.addEventListener("change", () => renderPattern(Number(elements.patternSelect.value)));
}

function renderPattern(index) {
  const group = patternGroups[index] || patternGroups[0];
  activeNetwork = buildRouteNetwork(routeData, group?.patterns);
  if (!activeNetwork?.lines.length) return fail("地図に描画できる座標が不足しています。");
  const selectedStopId = params.get("stop_id") || "";
  const orderedStopIds = [...new Set(activeNetwork.patterns.flatMap((pattern) => pattern.stopIds))];
  const stops = orderedStopIds.flatMap((stopId) => {
    const stop = routeData.stops?.[stopId];
    if (!stop) return [];
    return [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [Number(stop.lon), Number(stop.lat)] },
      properties: {
        label: stop.stop_name || stopId,
        platform: stop.platform_code || "",
        selected: stopId === selectedStopId,
      },
    }];
  });
  const lineFeatures = activeNetwork.lines.map((line) => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: line.coordinates.map(([lat, lon]) => [lon, lat]) },
    properties: { color: line.color, role: line.role },
  }));
  map.getSource("route-line").setData({ type: "FeatureCollection", features: lineFeatures });
  map.getSource("route-stops").setData({ type: "FeatureCollection", features: stops });
  const allCoordinates = lineFeatures.flatMap((feature) => feature.geometry.coordinates);
  const bounds = allCoordinates.reduce(
    (value, coordinate) => value.extend(coordinate),
    new maplibregl.LngLatBounds(allCoordinates[0], allCoordinates[0]),
  );
  map.fitBounds(bounds, { padding: 32, maxZoom: 16, duration: 0 });

  const routeName = routeData.route?.route_name || "都バス";
  const origins = activeNetwork.lines.map((line) => `${line.origin}発`);
  elements.title.textContent = `${routeName} 路線マップ`;
  elements.subtitle.textContent = origins.length > 1
    ? `${origins.join("・")} → ${activeNetwork.destination} ／ 主経路${activeNetwork.primaryStopCount}停留所 ／ 全体${activeNetwork.totalStopCount}停留所`
    : describeRoutePattern(routeData, activeNetwork.primary).subtitle;
  renderRouteLegend(activeNetwork);
  const exactShape = activeNetwork.lines.every((line) => line.exactShape);
  elements.status.className = `map-status ${exactShape ? "exact" : "approximate"}`;
  elements.status.textContent = exactShape
    ? (activeNetwork.lines.length > 1
      ? "赤が主経路、他の色が合流前の枝線です。合流後は主経路の色で表示しています。"
      : "GTFSの走行経路データを道路地図上に表示しています。")
    : "概略表示：現在のデータには走行経路がないため、停留所間を直線で結んでいます。実際の走行道路とは異なる場合があります。";
  if (realtimeFeed) renderVehicleMarkers();
}

function renderRouteLegend(network) {
  elements.legend.replaceChildren(...network.lines.map((line) => {
    const item = document.createElement("span");
    item.className = "route-legend-item";
    const swatch = document.createElement("span");
    swatch.className = "route-legend-line";
    swatch.style.setProperty("--line-color", line.color);
    const label = document.createElement("span");
    const mergeName = line.mergeStopId ? routeData.stops?.[line.mergeStopId]?.stop_name : "";
    label.textContent = line.role === "primary"
      ? `${line.origin}発（主経路）`
      : `${line.origin}発（${mergeName || "本線"}で合流）`;
    item.append(swatch, label);
    return item;
  }));
  elements.legend.hidden = network.lines.length < 2;
}

async function refreshRealtimeVehicles() {
  if (realtimeInFlight) return;
  realtimeInFlight = true;
  window.clearTimeout(realtimeTimer);
  try {
    realtimeFeed = await fetchRealtimeVehicles(REALTIME_SOURCES, {
      timeoutMs: REALTIME_TIMEOUT_MS,
      retries: 0,
    });
    renderVehicleMarkers();
  } catch (error) {
    elements.busStatus.className = "map-live-status error";
    elements.busStatus.textContent = `バス位置を更新できませんでした。${error.message || "通信状態を確認してください。"}`;
  } finally {
    realtimeInFlight = false;
    realtimeTimer = window.setTimeout(refreshRealtimeVehicles, REALTIME_REFRESH_MS);
  }
}

function renderVehicleMarkers() {
  vehicleMarkers.forEach((marker) => marker.remove());
  vehicleMarkers = [];
  if (!activeNetwork || !realtimeFeed) return;

  const nowMs = Date.now();
  const trips = new Map((routeData.trips || []).map((trip) => [trip.trip_id, trip]));
  const collisionCounts = new Map();
  for (const vehicle of realtimeFeed.vehicles || []) {
    const timestampMs = Number(vehicle.timestamp || realtimeFeed.timestamp || 0) * 1000;
    if (timestampMs && nowMs - timestampMs > REALTIME_VEHICLE_MAX_AGE_MS) continue;
    const trip = trips.get(vehicle.trip?.tripId);
    const pattern = activeNetwork.patterns.find((candidate) => tripMatchesRoutePattern(trip, candidate));
    if (!trip || !pattern) continue;
    const terminalStopId = pattern.stopIds[pattern.stopIds.length - 1];
    const estimate = estimateVehicleProgress(vehicle, trip, routeData, terminalStopId, nowMs);
    const coordinate = coordinateForVehicleEstimate(routeData, pattern, estimate);
    if (!coordinate) continue;

    const label = vehicle.vehicle?.label || vehicle.vehicle?.id || vehicle.entityId || "運行中のバス";
    const vehicleType = classifyVehicleType(label);
    const markerElement = document.createElement("button");
    markerElement.type = "button";
    markerElement.className = `bus-map-marker ${vehicleType.key}`;
    markerElement.textContent = vehicleType.marker;
    markerElement.title = `${label}：${estimate.currentLabel}`;
    markerElement.setAttribute("aria-label", markerElement.title);

    const popup = document.createElement("div");
    popup.className = "bus-popup";
    const title = document.createElement("strong");
    title.textContent = `${label}・${vehicleType.label}`;
    const location = document.createElement("span");
    location.textContent = estimate.currentLabel;
    const updated = document.createElement("span");
    updated.textContent = `位置更新 ${estimate.updatedAt}（停留所イベントから推定）`;
    popup.append(title, location, updated);

    const collisionKey = `${coordinate[0].toFixed(5)},${coordinate[1].toFixed(5)}`;
    const collisionIndex = collisionCounts.get(collisionKey) || 0;
    collisionCounts.set(collisionKey, collisionIndex + 1);
    const angle = collisionIndex * Math.PI * 2 / 6;
    const radius = collisionIndex ? 11 : 0;
    const marker = new maplibregl.Marker({
      element: markerElement,
      anchor: "center",
      offset: [Math.cos(angle) * radius, Math.sin(angle) * radius],
    })
      .setLngLat([coordinate[1], coordinate[0]])
      .setPopup(new maplibregl.Popup({ offset: 18 }).setDOMContent(popup))
      .addTo(map);
    vehicleMarkers.push(marker);
  }

  const stale = isRealtimeFeedStale(realtimeFeed, nowMs, 90_000);
  const feedTime = realtimeFeed.timestamp ? formatTimestampClock(realtimeFeed.timestamp * 1000) : "不明";
  elements.busStatus.className = `map-live-status${stale ? " error" : ""}`;
  elements.busStatus.textContent = vehicleMarkers.length
    ? `運行中 ${vehicleMarkers.length}台を表示・最終更新 ${feedTime}（停留所間の推定位置）`
    : `この経路を走行中のバスは現在確認できません・最終更新 ${feedTime}`;
}

function showStopPopup(event) {
  const feature = event.features?.[0];
  if (!feature) return;
  const popup = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = feature.properties.label || "停留所";
  popup.append(strong);
  if (feature.properties.platform) popup.append(document.createElement("br"), feature.properties.platform);
  new maplibregl.Popup({ offset: 8 }).setLngLat(feature.geometry.coordinates).setDOMContent(popup).addTo(map);
}

function emptyFeatureCollection() {
  return { type: "FeatureCollection", features: [] };
}

function fail(message) {
  elements.status.className = "map-status error";
  elements.status.textContent = message;
  elements.map.setAttribute("aria-hidden", "true");
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
