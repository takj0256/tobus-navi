import { buildRoutePatterns, coordinatesForPattern, isValidRouteFile } from "./route-map-model.js";

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
let routeLayer;
let stopLayer;
let routeData;
let patterns = [];

start();

async function start() {
  const routeFile = params.get("route_file") || "";
  if (!isValidRouteFile(routeFile)) return fail("路線データの指定が正しくありません。");
  if (!window.L) return fail("地図ライブラリを読み込めませんでした。通信状態を確認してください。");
  try {
    const response = await fetch(`./data/${routeFile}`);
    if (!response.ok) throw new Error(`路線データの取得に失敗しました（${response.status}）`);
    routeData = await response.json();
    patterns = buildRoutePatterns(routeData, {
      directionId: params.get("direction_id") || "",
      headsign: params.get("headsign") || "",
    });
    if (!patterns.length) throw new Error("表示できる停留所列がありません。");
    initializeMap();
    setupPatternSelector();
    renderPattern(0);
  } catch (error) {
    fail(error.message || "路線図を表示できませんでした。");
  }
}

function initializeMap() {
  map = L.map(elements.map, { zoomControl: true });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
}

function setupPatternSelector() {
  elements.patternSelect.replaceChildren(...patterns.map((pattern, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${pattern.headsign || "行き先不明"}（${pattern.stopIds.length}停留所）`;
    return option;
  }));
  elements.patternWrap.hidden = patterns.length < 2;
  elements.patternSelect.addEventListener("change", () => renderPattern(Number(elements.patternSelect.value)));
}

function renderPattern(index) {
  const pattern = patterns[index] || patterns[0];
  const { coordinates, exactShape } = coordinatesForPattern(routeData, pattern);
  if (coordinates.length < 2) return fail("地図に描画できる座標が不足しています。");
  if (routeLayer) routeLayer.remove();
  if (stopLayer) stopLayer.remove();

  routeLayer = L.polyline(coordinates, {
    color: exactShape ? "#0a5ea8" : "#d56b00",
    weight: 6,
    opacity: .88,
    dashArray: exactShape ? null : "10 8",
  }).addTo(map);
  stopLayer = L.layerGroup().addTo(map);
  const selectedStopId = params.get("stop_id") || "";
  pattern.stopIds.forEach((stopId, stopIndex) => {
    const stop = routeData.stops?.[stopId];
    if (!stop) return;
    const selected = stopId === selectedStopId;
    const marker = L.circleMarker([stop.lat, stop.lon], {
      radius: selected ? 8 : 5,
      color: selected ? "#a43a00" : "#fff",
      weight: selected ? 3 : 2,
      fillColor: selected ? "#ff9f43" : "#0a5ea8",
      fillOpacity: 1,
    });
    const popup = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = `${stopIndex + 1}. ${stop.stop_name || stopId}`;
    popup.append(strong);
    if (stop.platform_code) popup.append(document.createElement("br"), stop.platform_code);
    marker.bindPopup(popup).addTo(stopLayer);
  });
  map.fitBounds(routeLayer.getBounds(), { padding: [24, 24] });

  const routeName = routeData.route?.route_name || "都バス";
  elements.title.textContent = `${routeName} 路線マップ`;
  elements.subtitle.textContent = `${pattern.headsign || "行き先不明"}方面・${pattern.stopIds.length}停留所`;
  elements.status.className = `map-status ${exactShape ? "exact" : "approximate"}`;
  elements.status.textContent = exactShape
    ? "GTFSの走行経路データを道路地図上に表示しています。"
    : "概略表示：現在のデータには走行経路がないため、停留所間を直線で結んでいます。実際の走行道路とは異なる場合があります。";
}

function fail(message) {
  elements.status.className = "map-status error";
  elements.status.textContent = message;
  elements.map.setAttribute("aria-hidden", "true");
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
