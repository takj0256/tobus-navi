import {
  buildRoutePatterns,
  coordinatesForPattern,
  describeRoutePattern,
  isValidRouteFile,
} from "./route-map-model.js";

const params = new URLSearchParams(location.search);
const elements = {
  title: document.querySelector("#mapTitle"),
  subtitle: document.querySelector("#mapSubtitle"),
  status: document.querySelector("#mapStatus"),
  map: document.querySelector("#routeMap"),
  patternWrap: document.querySelector("#patternWrap"),
  patternSelect: document.querySelector("#patternSelect"),
};

let map;
let routeData;
let patterns = [];

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
    await initializeMap();
    setupPatternSelector();
    renderPattern(0);
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
    paint: { "line-color": "#0a5ea8", "line-width": 6, "line-opacity": .9 },
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
  elements.patternSelect.replaceChildren(...patterns.map((pattern, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = describeRoutePattern(routeData, pattern).selectorLabel;
    return option;
  }));
  elements.patternWrap.hidden = patterns.length < 2;
  elements.patternSelect.addEventListener("change", () => renderPattern(Number(elements.patternSelect.value)));
}

function renderPattern(index) {
  const pattern = patterns[index] || patterns[0];
  const description = describeRoutePattern(routeData, pattern);
  const { coordinates, exactShape } = coordinatesForPattern(routeData, pattern);
  if (coordinates.length < 2) return fail("地図に描画できる座標が不足しています。");
  const selectedStopId = params.get("stop_id") || "";
  const stops = pattern.stopIds.flatMap((stopId, stopIndex) => {
    const stop = routeData.stops?.[stopId];
    if (!stop) return [];
    return [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [Number(stop.lon), Number(stop.lat)] },
      properties: {
        label: `${stopIndex + 1}. ${stop.stop_name || stopId}`,
        platform: stop.platform_code || "",
        selected: stopId === selectedStopId,
      },
    }];
  });
  const lineCoordinates = coordinates.map(([lat, lon]) => [lon, lat]);
  map.getSource("route-line").setData({
    type: "Feature",
    geometry: { type: "LineString", coordinates: lineCoordinates },
    properties: {},
  });
  map.setPaintProperty("route-line", "line-color", exactShape ? "#0a5ea8" : "#d56b00");
  map.setPaintProperty("route-line", "line-dasharray", exactShape ? [1, 0] : [2, 1.6]);
  map.getSource("route-stops").setData({ type: "FeatureCollection", features: stops });
  const bounds = lineCoordinates.reduce(
    (value, coordinate) => value.extend(coordinate),
    new maplibregl.LngLatBounds(lineCoordinates[0], lineCoordinates[0]),
  );
  map.fitBounds(bounds, { padding: 32, maxZoom: 16, duration: 0 });

  const routeName = routeData.route?.route_name || "都バス";
  elements.title.textContent = `${routeName} 路線マップ`;
  elements.subtitle.textContent = description.subtitle;
  elements.status.className = `map-status ${exactShape ? "exact" : "approximate"}`;
  elements.status.textContent = exactShape
    ? "GTFSの走行経路データを道路地図上に表示しています。"
    : "概略表示：現在のデータには走行経路がないため、停留所間を直線で結んでいます。実際の走行道路とは異なる場合があります。";
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
