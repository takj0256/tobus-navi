import {
  buildMapRouteEntries,
  buildRouteNetwork,
  isValidRouteFile,
  sharedPlatformRouteFiles,
  selectMapVehicles,
  mapMarkerOffset,
} from "./route-map-model.js";
import {
  REALTIME_REFRESH_MS,
  REALTIME_SOURCES,
  REALTIME_TIMEOUT_MS,
  REALTIME_VEHICLE_MAX_AGE_MS,
} from "./config.js";
import {
  fetchRealtimeVehicles,
  isRealtimeFeedStale,
} from "./realtime.js";
import { formatTimestampClock } from "./timetable.js";
import { classifyVehicleType } from "./vehicle-type.js";
import { loadDataset, loadRouteData } from "./data.js";

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
  vehicleList: document.querySelector("#mapVehicleList"),
  vehicleSummary: document.querySelector("#mapVehicleSummary"),
};

let map;
let routeData;
let routeEntries = [];
let scopeOptions = [];
let activeEntries = [];
let dataWarnings = [];
let realtimeFeed;
let realtimeTimer;
let realtimeInFlight = false;
let vehicleMarkers = [];
let routeBounds;

start();

async function start() {
  const routeFile = params.get("route_file") || "";
  if (!isValidRouteFile(routeFile)) return fail("路線データの指定が正しくありません。");
  if (!window.maplibregl) return fail("地図ライブラリを読み込めませんでした。通信状態を確認してください。");
  try {
    routeData = await loadRouteData(routeFile);
    const stopId = params.get("stop_id") || "";
    let dataset;
    if (stopId) {
      try { dataset = await loadDataset(); }
      catch { dataWarnings.push("乗り場索引を取得できず、関連する別系統は未確認です。"); }
    }
    const files = sharedPlatformRouteFiles(dataset, stopId, routeFile);
    const loadedRoutes = [{ routeFile, routeData }];
    // ファイル単位で一度だけ取得。部分失敗でも選択系統の地図は残す。
    for (const file of files.filter((file) => file !== routeFile)) {
      try { loadedRoutes.push({ routeFile: file, routeData: await loadRouteData(file) }); }
      catch { dataWarnings.push("関連系統の一部データを取得できませんでした。"); }
    }
    routeEntries = buildMapRouteEntries(loadedRoutes, { primaryFile: routeFile, stopId });
    if (!routeEntries.length) throw new Error("表示できる停留所列がありません。");
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
  map.addSource("bus-positions", { type: "geojson", data: emptyFeatureCollection() });
  map.addLayer({
    id: "bus-positions", type: "circle", source: "bus-positions",
    paint: { "circle-radius": 4, "circle-color": ["case", ["get", "observedOnly"], "#eef5fa", "#ffd43b"],
      "circle-stroke-color": "#17324a", "circle-stroke-width": 2 },
  });
  map.on("click", "route-stops", showStopPopup);
  map.on("mouseenter", "route-stops", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "route-stops", () => { map.getCanvas().style.cursor = ""; });
}

function setupPatternSelector() {
  scopeOptions = [{ label: "関連する全系統・全行き先", entries: routeEntries }];
  for (const entry of routeEntries) {
    for (const group of entry.groups) {
      scopeOptions.push({
        label: `${entry.routeData.route?.route_name || "都バス"} ／ ${group.headsign || "行き先不明"}方面`,
        entries: [{ ...entry, patterns: group.patterns, allowUnmatchedPosition: false }],
      });
    }
  }
  elements.patternSelect.replaceChildren(...scopeOptions.map((scope, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = scope.label;
    return option;
  }));
  elements.patternWrap.hidden = false;
  elements.patternSelect.addEventListener("change", () => renderPattern(Number(elements.patternSelect.value)));
  // 車両一覧を開閉したときも地図キャンバスを実際の領域に合わせる。
  new ResizeObserver(() => map.resize()).observe(elements.map);
  document.querySelector("#mapFitAll").addEventListener("click", fitRouteBounds);
}

function renderPattern(index) {
  activeEntries = (scopeOptions[index] || scopeOptions[0]).entries;
  // 行き先の異なる経路を一つの「共通終点」へ誤って合流させない。
  const networks = activeEntries.flatMap((entry) => (
    entry.groups.flatMap((group) => {
      const patterns = group.patterns.filter((pattern) => entry.patterns.includes(pattern));
      return patterns.length ? [{ entry, network: buildRouteNetwork(entry.routeData, patterns) }] : [];
    })
  ));
  if (!networks.some(({ network }) => network?.lines.length)) return fail("地図に描画できる座標が不足しています。");
  const selectedStopId = params.get("stop_id") || "";
  const stopIds = new Set();
  const stops = activeEntries.flatMap((entry) => entry.patterns.flatMap((pattern) => pattern.stopIds.flatMap((stopId) => {
    const stop = entry.routeData.stops?.[stopId];
    if (stopIds.has(stopId) || !stop || !Number.isFinite(Number(stop.lat)) || !Number.isFinite(Number(stop.lon))) return [];
    stopIds.add(stopId);
    return [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [Number(stop.lon), Number(stop.lat)] },
      properties: {
        label: stop.stop_name || stopId,
        platform: stop.platform_code || "",
        selected: stopId === selectedStopId,
      },
    }];
  })));
  const lineFeatures = networks.flatMap(({ entry, network }) => network.lines.map((line) => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: line.coordinates.map(([lat, lon]) => [lon, lat]) },
    properties: { color: mapLineColor(entry, line), role: line.role },
  })));
  map.getSource("route-line").setData({ type: "FeatureCollection", features: lineFeatures });
  map.getSource("route-stops").setData({ type: "FeatureCollection", features: stops });
  const allCoordinates = lineFeatures.flatMap((feature) => feature.geometry.coordinates);
  const bounds = allCoordinates.reduce(
    (value, coordinate) => value.extend(coordinate),
    new maplibregl.LngLatBounds(allCoordinates[0], allCoordinates[0]),
  );
  routeBounds = bounds;
  fitRouteBounds();

  const routeName = routeData.route?.route_name || "都バス";
  const stopName = routeData.stops?.[selectedStopId]?.stop_name;
  elements.title.textContent = `${stopName || routeName} バスマップ`;
  elements.subtitle.textContent = index === 0
    ? `${routeName}の全方面${selectedStopId ? " ＋ 同じ乗り場を使う別系統の便" : ""} ／ ${stopIds.size}停留所`
    : `${scopeOptions[index].label} ／ ${stopIds.size}停留所`;
  renderRouteLegend(networks);
  const exactShape = networks.every(({ network }) => network.lines.every((line) => line.exactShape));
  elements.status.className = `map-status ${exactShape ? "exact" : "approximate"}`;
  elements.status.textContent = exactShape
    ? "GTFS経路を表示。バスに系統・行き先を併記し、タップで詳細を開きます。"
    : "概略表示：現在のデータには走行経路がないため、停留所間を直線で結んでいます。実際の走行道路とは異なる場合があります。";
  elements.status.textContent += " 小さい点がバス位置です。重なるアイコンはずらして表示し、全台は一覧からも選べます。";
  if (dataWarnings.length) {
    elements.status.className = "map-status error";
    elements.status.textContent += ` ${[...new Set(dataWarnings)].join(" ")}`;
  }
  if (realtimeFeed) renderVehicleMarkers();
}

function renderRouteLegend(networks) {
  elements.legend.replaceChildren(...networks.flatMap(({ entry, network }) => network.lines.map((line) => {
    const item = document.createElement("span");
    item.className = "route-legend-item";
    const swatch = document.createElement("span");
    swatch.className = "route-legend-line";
    swatch.style.setProperty("--line-color", mapLineColor(entry, line));
    const label = document.createElement("span");
    const mergeName = line.mergeStopId ? entry.routeData.stops?.[line.mergeStopId]?.stop_name : "";
    label.textContent = `${entry.routeData.route?.route_name || "都バス"} ${line.origin}発 → ${network.destination}${mergeName ? `（${mergeName}で合流）` : ""}`;
    item.append(swatch, label);
    return item;
  })));
  elements.legend.hidden = networks.length === 1 && networks[0].network.lines.length < 2;
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
    // 更新できない過去位置を「実際に走行中」と残さない。
    realtimeFeed = null;
    clearVehicleMarkers();
    elements.busStatus.className = "map-live-status error";
    elements.busStatus.textContent = `バス位置を更新できませんでした。${error.message || "通信状態を確認してください。"}`;
  } finally {
    realtimeInFlight = false;
    realtimeTimer = window.setTimeout(refreshRealtimeVehicles, REALTIME_REFRESH_MS);
  }
}

function renderVehicleMarkers() {
  clearVehicleMarkers();
  if (!activeEntries.length || !realtimeFeed) return;

  const nowMs = Date.now();
  const selected = selectMapVehicles(activeEntries, realtimeFeed, { nowMs, maxAgeMs: REALTIME_VEHICLE_MAX_AGE_MS });
  map.getSource("bus-positions").setData({ type: "FeatureCollection", features: selected.vehicles.map((item) => ({
    type: "Feature", geometry: { type: "Point", coordinates: [item.coordinate[1], item.coordinate[0]] },
    properties: { observedOnly: !!item.observedOnly },
  })) });
  const collisionCounts = new Map();
  for (const { vehicle, estimate, coordinate, routeName, headsign, observedOnly } of selected.vehicles) {
    const destinationLabel = observedOnly ? headsign : `${headsign}行き`;
    const label = vehicle.vehicle?.label || vehicle.vehicle?.id || vehicle.entityId || "運行中のバス";
    const vehicleType = classifyVehicleType(label);
    const markerElement = document.createElement("button");
    markerElement.type = "button";
    markerElement.className = `bus-map-marker ${vehicleType.key}${observedOnly ? " observed-only" : ""}`;
    const icon = document.createElement("span");
    icon.className = "bus-map-icon";
    icon.textContent = `${vehicleType.marker} ${routeName}`;
    const destination = document.createElement("span");
    destination.className = "bus-map-destination";
    destination.textContent = destinationLabel;
    markerElement.append(icon, destination);
    markerElement.title = `${routeName} ${destinationLabel} ／ ${label}：${estimate.currentLabel}`;
    markerElement.setAttribute("aria-label", markerElement.title);

    const popup = document.createElement("div");
    popup.className = "bus-popup";
    const title = document.createElement("strong");
    title.textContent = `${label}・${vehicleType.label}`;
    const service = document.createElement("strong");
    service.textContent = `${routeName} ／ ${destinationLabel}`;
    const location = document.createElement("span");
    location.textContent = estimate.currentLabel;
    const updated = document.createElement("span");
    updated.textContent = `位置更新 ${estimate.updatedAt}（${observedOnly ? "配信座標・経路と行き先は未確認" : "停留所イベントから推定"}）`;
    popup.append(service, title, location, updated);

    const collisionKey = `${coordinate[0].toFixed(5)},${coordinate[1].toFixed(5)}`;
    const collisionIndex = collisionCounts.get(collisionKey) || 0;
    collisionCounts.set(collisionKey, collisionIndex + 1);
    const marker = new maplibregl.Marker({
      element: markerElement,
      anchor: "center",
      offset: mapMarkerOffset(collisionIndex),
    })
      .setLngLat([coordinate[1], coordinate[0]])
      .setPopup(new maplibregl.Popup({ offset: 18 }).setDOMContent(popup))
      .addTo(map);
    vehicleMarkers.push(marker);
    const listButton = document.createElement("button");
    listButton.type = "button";
    listButton.className = "map-vehicle-item";
    listButton.textContent = `${routeName} ／ ${destinationLabel} ／ ${label} ／ ${estimate.currentLabel}`;
    listButton.addEventListener("click", () => {
      for (const other of vehicleMarkers) if (other.getPopup().isOpen()) other.togglePopup();
      map.flyTo({ center: [coordinate[1], coordinate[0]], zoom: 15 });
      marker.togglePopup();
    });
    elements.vehicleList.append(listButton);
  }

  const stale = isRealtimeFeedStale(realtimeFeed, nowMs, 90_000);
  const feedTime = realtimeFeed.timestamp ? formatTimestampClock(realtimeFeed.timestamp * 1000) : "不明";
  elements.busStatus.className = `map-live-status${stale || selected.unmatchedTrips || selected.unlocated ? " error" : ""}`;
  elements.busStatus.textContent = vehicleMarkers.length
    ? `${stale ? "古い配信位置" : "運行中"} ${vehicleMarkers.length}台を表示・最終更新 ${feedTime}（停留所間の推定位置）`
    : `表示範囲の走行中のバスは現在確認できません・最終更新 ${feedTime}`;
  if (stale) elements.busStatus.textContent += " ／ 配信が古いため現在位置は確認中です。";
  if (selected.unmatchedTrips) elements.busStatus.textContent += ` ／ 未照合の便${selected.unmatchedTrips}台（${selected.observedPositions}台は配信位置のみ表示・${selected.unmatchedTrips - selected.observedPositions}台は対象外。静的GTFS更新が必要な可能性）`;
  if (selected.unlocated) elements.busStatus.textContent += ` ／ 位置未確認${selected.unlocated}台`;
  if (selected.stale) elements.busStatus.textContent += ` ／ 鮮度不明・期限外${selected.stale}台は非表示`;
  elements.vehicleSummary.textContent = `表示中の車両 ${vehicleMarkers.length}台（一覧から選択）`;
}

function clearVehicleMarkers() {
  vehicleMarkers.forEach((marker) => marker.remove());
  vehicleMarkers = [];
  elements.vehicleList.replaceChildren();
  elements.vehicleSummary.textContent = "表示中の車両 0台";
  map?.getSource("bus-positions")?.setData(emptyFeatureCollection());
}

function fitRouteBounds() {
  if (!routeBounds) return;
  map.resize();
  map.fitBounds(routeBounds, { padding: { top: 80, bottom: 130, left: 125, right: 125 }, maxZoom: 16, duration: 0 });
}

function mapLineColor(entry, line) {
  if (line.role !== "primary") return line.color;
  const palette = ["#d53838", "#1769aa", "#16845b", "#7a4db3", "#d06a18"];
  const index = routeEntries.findIndex((item) => item.routeFile === entry.routeFile);
  return palette[Math.max(0, index) % palette.length];
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
