import {
  getCurrentPosition,
  getGeolocationPermissionState,
  geolocationErrorMessage,
  formatDistance,
} from "./geo.js";
import { loadDataset, nearbyStops, searchStops } from "./data.js";
import { openOfficial } from "./official.js";
import { displayHeadsign } from "./display.js";

const elements = {
  locateButton: document.querySelector("#locateButton"),
  refreshButton: document.querySelector("#refreshButton"),
  radiusSelect: document.querySelector("#radiusSelect"),
  manualSearchForm: document.querySelector("#manualSearchForm"),
  manualSearchInput: document.querySelector("#manualSearchInput"),
  demoButton: document.querySelector("#demoButton"),
  resultsList: document.querySelector("#resultsList"),
  resultCount: document.querySelector("#resultCount"),
  resultsTitle: document.querySelector("#results-title"),
  resultsEyebrow: document.querySelector("#resultsEyebrow"),
  statusPanel: document.querySelector("#statusPanel"),
  statusTitle: document.querySelector("#statusTitle"),
  statusMessage: document.querySelector("#statusMessage"),
  statusIcon: document.querySelector("#statusIcon"),
  toast: document.querySelector("#toast"),
  favoritesSection: document.querySelector("#favoritesSection"),
  favoritesList: document.querySelector("#favoritesList"),
  clearFavoritesButton: document.querySelector("#clearFavoritesButton"),
  installButton: document.querySelector("#installButton"),
  aboutButton: document.querySelector("#aboutButton"),
  closeAboutButton: document.querySelector("#closeAboutButton"),
  aboutDialog: document.querySelector("#aboutDialog"),
  datasetLabel: document.querySelector("#datasetLabel"),
};

const state = {
  dataset: { meta: {}, stops: [] },
  lastPosition: null,
  deferredInstallPrompt: null,
  favorites: loadFavorites(),
};

init();

async function init() {
  bindEvents();
  registerServiceWorker();
  try {
    state.dataset = await loadDataset();
    const meta = state.dataset.meta || {};
    const label = meta.dataset_name || "停留所データ";
    elements.datasetLabel.textContent = `${label}（${state.dataset.stops.length}停留所）`;
    renderFavorites();
    await prepareInitialLocationSearch(meta);
  } catch (error) {
    console.error(error);
    setStatus("error", "データの読み込みに失敗しました", error.message);
  }
}

async function prepareInitialLocationSearch(meta) {
  const dataMessage = meta.demo
    ? "現在はデモデータです。実運用には公式GTFS-JPからデータを生成してください。"
    : `${state.dataset.stops.length}件の停留所データを読み込みました。`;

  const permissionState = await getGeolocationPermissionState();

  if (permissionState === "granted") {
    // すでに許可済みの場合だけ、要件どおり起動時に自動検索する。
    await locateAndSearch();
    return;
  }

  if (permissionState === "denied") {
    setStatus(
      "warning",
      "位置情報が無効です",
      `${dataMessage} ブラウザ設定で位置情報を許可するか、停留所名検索を使用してください。`,
    );
    return;
  }

  setStatus(
    "success",
    "準備できました",
    `${dataMessage} 「現在地から検索」をタップすると、位置情報の利用許可を確認します。`,
  );
}

function bindEvents() {
  elements.locateButton.addEventListener("click", locateAndSearch);
  elements.refreshButton.addEventListener("click", () => {
    if (state.lastPosition) renderNearby(state.lastPosition.coords.latitude, state.lastPosition.coords.longitude);
    else locateAndSearch();
  });
  elements.radiusSelect.addEventListener("change", () => {
    if (state.lastPosition) renderNearby(state.lastPosition.coords.latitude, state.lastPosition.coords.longitude);
  });
  elements.manualSearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = elements.manualSearchInput.value.trim();
    if (!query) {
      showToast("停留所名または駅名を入力してください。");
      return;
    }
    const matches = searchStops(state.dataset.stops, query);
    elements.resultsTitle.textContent = `「${query}」の検索結果`;
    elements.resultsEyebrow.textContent = "停留所名検索";
    renderStops(matches, false);
    setStatus(matches.length ? "success" : "warning", matches.length ? "検索しました" : "該当なし",
      matches.length ? `${matches.length}件の候補を表示しています。` : "別の停留所名や駅名で検索してください。");
  });
  elements.demoButton.addEventListener("click", () => {
    const demo = { latitude: 35.6909, longitude: 139.6995 };
    state.lastPosition = { coords: demo };
    renderNearby(demo.latitude, demo.longitude, "新宿駅西口付近（デモ位置）");
  });
  elements.clearFavoritesButton.addEventListener("click", () => {
    state.favorites = [];
    saveFavorites();
    renderFavorites();
    renderCurrentResultsFavorites();
  });
  elements.aboutButton.addEventListener("click", () => elements.aboutDialog.showModal());
  elements.closeAboutButton.addEventListener("click", () => elements.aboutDialog.close());
  elements.installButton.addEventListener("click", installPwa);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    elements.installButton.classList.remove("hidden");
  });
}

async function locateAndSearch() {
  if (!state.dataset.stops.length) {
    setStatus("warning", "停留所データがありません", "先に停留所データを読み込んでください。");
    return;
  }
  setBusy(true);
  setStatus("loading", "現在地を取得しています", "位置情報の許可画面が表示されたら「許可」を選択してください。");
  try {
    const position = await getCurrentPosition();
    state.lastPosition = position;
    renderNearby(position.coords.latitude, position.coords.longitude);
  } catch (error) {
    console.error(error);
    setStatus("error", "現在地を取得できませんでした", geolocationErrorMessage(error));
  } finally {
    setBusy(false);
  }
}

function renderNearby(latitude, longitude, label = "現在地") {
  const radius = Number(elements.radiusSelect.value);
  const matches = nearbyStops(state.dataset.stops, latitude, longitude, radius);
  elements.resultsTitle.textContent = `${label}から近い停留所`;
  elements.resultsEyebrow.textContent = `半径 ${radius >= 1000 ? `${radius / 1000} km` : `${radius} m`}`;
  renderStops(matches, true);
  setStatus(matches.length ? "success" : "warning", matches.length ? "周辺検索が完了しました" : "近くに候補がありません",
    matches.length ? `精度 約${Math.round(state.lastPosition?.coords?.accuracy || 0)}m・${matches.length}件を距離順に表示しています。`
      : "検索半径を広げるか、停留所名検索を使用してください。");
}

function renderStops(stops, showDistance) {
  elements.resultCount.textContent = `${stops.length}件`;
  if (!stops.length) {
    elements.resultsList.innerHTML = `<div class="empty-state"><span aria-hidden="true">🚌</span><p>表示できる停留所がありません。</p></div>`;
    return;
  }

  elements.resultsList.innerHTML = stops.map((stop) => {
    const routes = deduplicateRoutes(stop.routes || []);
    return `
      <article class="stop-card" data-stop-id="${escapeHtml(stop.stop_id)}">
        <div class="stop-header">
          <div class="stop-title-row">
            <h3 class="stop-title">${escapeHtml(stop.stop_name)}</h3>
            ${showDistance ? `<span class="distance">${formatDistance(stop.distance)}</span>` : ""}
          </div>
          <div class="stop-meta">
            ${stop.platform_code ? `<span class="meta-chip">${escapeHtml(stop.platform_code)}</span>` : ""}
            <span class="meta-chip">${routes.length}系統・方面</span>
          </div>
        </div>
        <div class="route-list">
          ${routes.length ? routes.map((route) => routeRow(stop, route)).join("")
            : `<p>この停留所の系統情報がありません。</p>`}
        </div>
      </article>`;
  }).join("");

  elements.resultsList.querySelectorAll("[data-route-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const stop = findStop(button.dataset.stopId);
      const route = findRoute(stop, button.dataset.routeKey);
      recordRecent(stop, route);
      openOfficial(stop, route, showToast);
    });
  });
  elements.resultsList.querySelectorAll("[data-favorite-action]").forEach((button) => {
    button.addEventListener("click", () => toggleFavorite(button.dataset.stopId, button.dataset.routeKey));
  });
}

function routeRow(stop, route) {
  const routeKey = createRouteKey(route);
  const favorite = isFavorite(stop.stop_id, routeKey);
  return `<div class="route-row">
    <button class="route-button" type="button" data-route-action data-stop-id="${escapeHtml(stop.stop_id)}" data-route-key="${escapeHtml(routeKey)}">
      <span class="route-name">${escapeHtml(route.route_name || "系統")}</span>
      <span class="route-headsign">${escapeHtml(displayHeadsign(route.headsign))}</span>
      <span aria-hidden="true">↗</span>
    </button>
    <button class="favorite-button" type="button" data-favorite-action data-stop-id="${escapeHtml(stop.stop_id)}" data-route-key="${escapeHtml(routeKey)}" aria-label="お気に入り${favorite ? "から解除" : "に追加"}" aria-pressed="${favorite}">★</button>
  </div>`;
}

function toggleFavorite(stopId, routeKey) {
  const index = state.favorites.findIndex((item) => item.stop_id === stopId && item.route_key === routeKey);
  if (index >= 0) {
    state.favorites.splice(index, 1);
    showToast("お気に入りから解除しました。");
  } else {
    const stop = findStop(stopId);
    const route = findRoute(stop, routeKey);
    if (!stop || !route) return;
    state.favorites.unshift({
      stop_id: stop.stop_id,
      stop_name: stop.stop_name,
      platform_code: stop.platform_code || "",
      route_key: routeKey,
      route_name: route.route_name || "",
      headsign: route.headsign || "",
      official_url: route.official_url || stop.official_url || "",
    });
    state.favorites = state.favorites.slice(0, 20);
    showToast("お気に入りに追加しました。");
  }
  saveFavorites();
  renderFavorites();
  renderCurrentResultsFavorites();
}

function renderFavorites() {
  elements.favoritesSection.classList.toggle("hidden", state.favorites.length === 0);
  elements.favoritesList.innerHTML = state.favorites.map((item) => `
    <div class="favorite-card">
      <button class="route-button" type="button" data-favorite-open data-stop-id="${escapeHtml(item.stop_id)}" data-route-key="${escapeHtml(item.route_key)}">
        <span class="route-name">${escapeHtml(item.route_name || "系統")}</span>
        <span class="route-headsign">${escapeHtml(item.stop_name)} → ${escapeHtml(displayHeadsign(item.headsign))}</span>
        <span aria-hidden="true">↗</span>
      </button>
      <button class="favorite-button" type="button" data-favorite-remove data-stop-id="${escapeHtml(item.stop_id)}" data-route-key="${escapeHtml(item.route_key)}" aria-label="お気に入りから解除" aria-pressed="true">★</button>
    </div>`).join("");

  elements.favoritesList.querySelectorAll("[data-favorite-open]").forEach((button) => {
    button.addEventListener("click", () => {
      const stored = state.favorites.find((item) => item.stop_id === button.dataset.stopId && item.route_key === button.dataset.routeKey);
      const stop = findStop(button.dataset.stopId) || stored;
      const route = findRoute(stop, button.dataset.routeKey) || stored;
      openOfficial(stop, route, showToast);
    });
  });
  elements.favoritesList.querySelectorAll("[data-favorite-remove]").forEach((button) => {
    button.addEventListener("click", () => toggleFavorite(button.dataset.stopId, button.dataset.routeKey));
  });
}

function renderCurrentResultsFavorites() {
  elements.resultsList.querySelectorAll("[data-favorite-action]").forEach((button) => {
    const favorite = isFavorite(button.dataset.stopId, button.dataset.routeKey);
    button.setAttribute("aria-pressed", String(favorite));
    button.setAttribute("aria-label", `お気に入り${favorite ? "から解除" : "に追加"}`);
  });
}

function findStop(stopId) {
  return state.dataset.stops.find((stop) => String(stop.stop_id) === String(stopId));
}
function findRoute(stop, routeKey) {
  return stop?.routes?.find((route) => createRouteKey(route) === routeKey);
}
function createRouteKey(route) {
  return [route.route_id || "", route.route_name || "", route.headsign || "", route.direction_id ?? ""].join("|");
}
function deduplicateRoutes(routes) {
  const seen = new Set();
  return routes.filter((route) => {
    const key = createRouteKey(route);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => String(a.route_name).localeCompare(String(b.route_name), "ja") || String(a.headsign).localeCompare(String(b.headsign), "ja"));
}
function isFavorite(stopId, routeKey) {
  return state.favorites.some((item) => item.stop_id === stopId && item.route_key === routeKey);
}
function loadFavorites() {
  try { return JSON.parse(localStorage.getItem("tobus-navi-favorites") || "[]"); }
  catch { return []; }
}
function saveFavorites() {
  localStorage.setItem("tobus-navi-favorites", JSON.stringify(state.favorites));
}
function recordRecent(stop, route) {
  if (!stop || !route) return;
  const recent = { stop_id: stop.stop_id, route_key: createRouteKey(route), at: Date.now() };
  localStorage.setItem("tobus-navi-recent", JSON.stringify(recent));
}

function setStatus(stateName, title, message) {
  elements.statusPanel.dataset.state = stateName;
  elements.statusTitle.textContent = title;
  elements.statusMessage.textContent = message;
  elements.statusIcon.textContent = stateName === "error" ? "!" : stateName === "warning" ? "▲" : stateName === "loading" ? "…" : "●";
}
function setBusy(busy) {
  elements.locateButton.disabled = busy;
  elements.refreshButton.disabled = busy;
  elements.locateButton.textContent = busy ? "現在地を取得中…" : "◎ 現在地から検索";
}
let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 4200);
}
function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

async function installPwa() {
  if (!state.deferredInstallPrompt) return;
  state.deferredInstallPrompt.prompt();
  await state.deferredInstallPrompt.userChoice;
  state.deferredInstallPrompt = null;
  elements.installButton.classList.add("hidden");
}
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.error));
  }
}
