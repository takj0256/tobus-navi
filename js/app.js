import {
  getCurrentPosition,
  getGeolocationPermissionState,
  geolocationErrorMessage,
  formatDistance,
} from "./geo.js";
import { loadDataset, nearbyStops, searchStops } from "./data.js";
import { openOfficial } from "./official.js";
import { displayHeadsign } from "./display.js";
import {
  buildSuggestionIndex,
  suggestSearchTerms,
  suggestionTypeLabel,
} from "./suggest.js";

const elements = {
  locateButton: document.querySelector("#locateButton"),
  refreshButton: document.querySelector("#refreshButton"),
  radiusSelect: document.querySelector("#radiusSelect"),
  manualSearchForm: document.querySelector("#manualSearchForm"),
  manualSearchInput: document.querySelector("#manualSearchInput"),
  searchSuggestions: document.querySelector("#searchSuggestions"),
  results: document.querySelector("#results"),
  resultsList: document.querySelector("#resultsList"),
  resultCount: document.querySelector("#resultCount"),
  resultsTitle: document.querySelector("#results-title"),
  resultsEyebrow: document.querySelector("#resultsEyebrow"),
  statusPanel: document.querySelector("#statusPanel"),
  statusTitle: document.querySelector("#statusTitle"),
  statusMessage: document.querySelector("#statusMessage"),
  statusIcon: document.querySelector("#statusIcon"),
  datasetSummary: document.querySelector("#datasetSummary"),
  toast: document.querySelector("#toast"),
  favoritesSection: document.querySelector("#favoritesSection"),
  favoritesList: document.querySelector("#favoritesList"),
  clearFavoritesButton: document.querySelector("#clearFavoritesButton"),
  recentSection: document.querySelector("#recentSection"),
  recentList: document.querySelector("#recentList"),
  clearRecentButton: document.querySelector("#clearRecentButton"),
  installButton: document.querySelector("#installButton"),
  aboutButton: document.querySelector("#aboutButton"),
  closeAboutButton: document.querySelector("#closeAboutButton"),
  aboutDialog: document.querySelector("#aboutDialog"),
  datasetLabel: document.querySelector("#datasetLabel"),
  datasetUpdatedAt: document.querySelector("#datasetUpdatedAt"),
};

const state = {
  dataset: { meta: {}, stops: [] },
  suggestionIndex: [],
  suggestions: [],
  activeSuggestionIndex: -1,
  lastPosition: null,
  deferredInstallPrompt: null,
  currentView: { stops: [], showDistance: false },
  favorites: loadArray("tobus-navi-favorites"),
  recents: loadRecents(),
};

init();

async function init() {
  bindEvents();
  registerServiceWorker();
  try {
    state.dataset = await loadDataset();
    state.suggestionIndex = buildSuggestionIndex(state.dataset.stops);
    state.favorites = hydrateStoredRoutes(state.favorites);
    state.recents = hydrateStoredRoutes(state.recents);
    saveArray("tobus-navi-favorites", state.favorites);
    saveArray("tobus-navi-recents", state.recents);
    const meta = state.dataset.meta || {};
    const label = meta.dataset_name || "都バス停留所データ";
    const generatedAt = formatDatasetDate(meta.generated_at);

    elements.datasetLabel.textContent = `${label}（${state.dataset.stops.length}停留所）`;
    elements.datasetUpdatedAt.textContent = generatedAt;
    elements.datasetSummary.textContent = `データ生成：${generatedAt}`;

    renderFavorites();
    renderRecents();
    await prepareInitialLocationSearch();
  } catch (error) {
    console.error(error);
    setDataControlsEnabled(false);
    elements.datasetLabel.textContent = "正式データを読み込めませんでした";
    elements.datasetUpdatedAt.textContent = "未取得";
    setStatus("error", "停留所データを利用できません", error.message);
    elements.datasetSummary.textContent = "UbuntuでGTFS-JPを変換し、data/stops.jsonを生成してください。";
  }
}

async function prepareInitialLocationSearch() {
  const dataMessage = `${state.dataset.stops.length}件の停留所データを読み込みました。`;
  const permissionState = await getGeolocationPermissionState();

  if (permissionState === "granted") {
    await locateAndSearch();
    return;
  }

  if (permissionState === "denied") {
    setStatus(
      "warning",
      "位置情報が無効です",
      `${dataMessage} ブラウザ設定で位置情報を許可するか、検索欄を使用してください。`,
    );
    return;
  }

  setStatus(
    "success",
    "準備できました",
    `${dataMessage} 「現在地から検索」をタップするか、停留所・系統・行き先を入力してください。`,
  );
}

function bindEvents() {
  elements.locateButton.addEventListener("click", locateAndSearch);
  elements.refreshButton.addEventListener("click", () => {
    if (state.lastPosition) {
      renderNearby(state.lastPosition.coords.latitude, state.lastPosition.coords.longitude);
    } else {
      locateAndSearch();
    }
  });
  elements.radiusSelect.addEventListener("change", () => {
    if (state.lastPosition) {
      renderNearby(state.lastPosition.coords.latitude, state.lastPosition.coords.longitude);
    }
  });

  elements.manualSearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.activeSuggestionIndex >= 0 && state.suggestions[state.activeSuggestionIndex]) {
      selectSuggestion(state.activeSuggestionIndex);
      return;
    }
    runManualSearch(elements.manualSearchInput.value);
  });
  elements.manualSearchInput.addEventListener("input", updateSuggestions);
  elements.manualSearchInput.addEventListener("focus", updateSuggestions);
  elements.manualSearchInput.addEventListener("keydown", handleSuggestionKeydown);
  elements.manualSearchInput.addEventListener("blur", () => {
    window.setTimeout(hideSuggestions, 150);
  });

  elements.clearFavoritesButton.addEventListener("click", () => {
    state.favorites = [];
    saveArray("tobus-navi-favorites", state.favorites);
    renderFavorites();
    if (state.currentView.stops.length) {
      renderStops(state.currentView.stops, state.currentView.showDistance);
    } else {
      renderCurrentResultsFavorites();
    }
  });
  elements.clearRecentButton.addEventListener("click", () => {
    state.recents = [];
    saveArray("tobus-navi-recents", state.recents);
    localStorage.removeItem("tobus-navi-recent");
    renderRecents();
    if (state.currentView.stops.length) {
      renderStops(state.currentView.stops, state.currentView.showDistance);
    }
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

function updateSuggestions() {
  const query = elements.manualSearchInput.value.trim();
  state.suggestions = suggestSearchTerms(state.suggestionIndex, query, 8);
  state.activeSuggestionIndex = -1;
  renderSuggestions();
}

function renderSuggestions() {
  if (!state.suggestions.length) {
    hideSuggestions();
    return;
  }

  elements.searchSuggestions.innerHTML = state.suggestions.map((suggestion, index) => `
    <button
      id="suggestion-option-${index}"
      class="suggestion-item"
      type="button"
      role="option"
      data-suggestion-index="${index}"
      aria-selected="${index === state.activeSuggestionIndex}"
    >
      <span class="suggestion-type">${escapeHtml(suggestionTypeLabel(suggestion.type))}</span>
      <span class="suggestion-value">${escapeHtml(suggestion.value)}</span>
    </button>
  `).join("");

  elements.searchSuggestions.querySelectorAll("[data-suggestion-index]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => selectSuggestion(Number(button.dataset.suggestionIndex)));
  });

  elements.searchSuggestions.classList.remove("hidden");
  elements.manualSearchInput.setAttribute("aria-expanded", "true");
  updateActiveSuggestion();
}

function handleSuggestionKeydown(event) {
  if (!state.suggestions.length) {
    if (event.key === "Escape") hideSuggestions();
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    state.activeSuggestionIndex = (state.activeSuggestionIndex + 1) % state.suggestions.length;
    updateActiveSuggestion();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    state.activeSuggestionIndex = state.activeSuggestionIndex <= 0
      ? state.suggestions.length - 1
      : state.activeSuggestionIndex - 1;
    updateActiveSuggestion();
  } else if (event.key === "Enter" && state.activeSuggestionIndex >= 0) {
    event.preventDefault();
    selectSuggestion(state.activeSuggestionIndex);
  } else if (event.key === "Escape") {
    event.preventDefault();
    hideSuggestions();
  }
}

function updateActiveSuggestion() {
  elements.searchSuggestions.querySelectorAll("[data-suggestion-index]").forEach((button, index) => {
    const active = index === state.activeSuggestionIndex;
    button.setAttribute("aria-selected", String(active));
    button.classList.toggle("active", active);
    if (active) button.scrollIntoView({ block: "nearest" });
  });

  if (state.activeSuggestionIndex >= 0) {
    elements.manualSearchInput.setAttribute("aria-activedescendant", `suggestion-option-${state.activeSuggestionIndex}`);
  } else {
    elements.manualSearchInput.removeAttribute("aria-activedescendant");
  }
}

function selectSuggestion(index) {
  const suggestion = state.suggestions[index];
  if (!suggestion) return;
  elements.manualSearchInput.value = suggestion.value;
  hideSuggestions();
  runManualSearch(suggestion.value, suggestionTypeLabel(suggestion.type));
}

function hideSuggestions() {
  state.suggestions = [];
  state.activeSuggestionIndex = -1;
  elements.searchSuggestions.innerHTML = "";
  elements.searchSuggestions.classList.add("hidden");
  elements.manualSearchInput.setAttribute("aria-expanded", "false");
  elements.manualSearchInput.removeAttribute("aria-activedescendant");
}

function runManualSearch(rawQuery, sourceLabel = "キーワード検索") {
  const query = String(rawQuery || "").trim();
  if (!query) {
    showToast("停留所名、系統番号、または行き先を入力してください。");
    return;
  }

  const matches = searchStops(state.dataset.stops, query);
  elements.resultsTitle.textContent = `「${query}」の検索結果`;
  elements.resultsEyebrow.textContent = sourceLabel;
  renderStops(matches, false);
  setStatus(
    matches.length ? "success" : "warning",
    matches.length ? "検索しました" : "該当なし",
    matches.length
      ? `${matches.length}件の停留所候補を表示しています。`
      : "別の停留所名、系統番号、または行き先で検索してください。",
  );
  elements.results.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function locateAndSearch() {
  if (!state.dataset.stops.length) {
    setStatus("warning", "停留所データがありません", "正式GTFS-JPから停留所データを生成してください。");
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
  setStatus(
    matches.length ? "success" : "warning",
    matches.length ? "周辺検索が完了しました" : "近くに候補がありません",
    matches.length
      ? `精度 約${Math.round(state.lastPosition?.coords?.accuracy || 0)}m・${matches.length}件を距離順に表示しています。`
      : "検索半径を広げるか、検索欄を使用してください。",
  );
}

function renderStops(stops, showDistance) {
  state.currentView = { stops, showDistance };
  elements.resultCount.textContent = `${stops.length}件`;
  if (!stops.length) {
    elements.resultsList.innerHTML = `<div class="empty-state"><span aria-hidden="true">🚌</span><p>表示できる停留所がありません。</p></div>`;
    return;
  }

  elements.resultsList.innerHTML = stops.map((stop) => {
    const routes = deduplicateRoutes(stop.stop_id, stop.routes || []);
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
          ${routes.length
            ? routes.map((route) => routeRow(stop, route)).join("")
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
  const recent = isRecent(stop.stop_id, routeKey);
  return `<div class="route-row ${favorite ? "priority-route" : ""}">
    <button class="route-button" type="button" data-route-action data-stop-id="${escapeHtml(stop.stop_id)}" data-route-key="${escapeHtml(routeKey)}">
      <span class="route-name">${escapeHtml(route.route_name || "系統")}</span>
      <span class="route-headsign">${escapeHtml(displayHeadsign(route.headsign))}</span>
      ${favorite ? `<span class="route-state">お気に入り</span>` : recent ? `<span class="route-state">最近</span>` : ""}
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
    state.favorites.unshift(createStoredRoute(stop, route));
    state.favorites = state.favorites.slice(0, 20);
    showToast("お気に入りに追加しました。");
  }
  saveArray("tobus-navi-favorites", state.favorites);
  renderFavorites();
  if (state.currentView.stops.length) {
    renderStops(state.currentView.stops, state.currentView.showDistance);
  } else {
    renderCurrentResultsFavorites();
  }
}

function renderFavorites() {
  elements.favoritesSection.classList.toggle("hidden", state.favorites.length === 0);
  elements.favoritesList.innerHTML = state.favorites.map((item) => `
    <div class="favorite-card">
      ${storedRouteButton(item, "data-favorite-open")}
      <button class="favorite-button" type="button" data-favorite-remove data-stop-id="${escapeHtml(item.stop_id)}" data-route-key="${escapeHtml(item.route_key)}" aria-label="お気に入りから解除" aria-pressed="true">★</button>
    </div>`).join("");

  elements.favoritesList.querySelectorAll("[data-favorite-open]").forEach((button) => {
    button.addEventListener("click", () => openStoredRoute(button.dataset.stopId, button.dataset.routeKey, state.favorites));
  });
  elements.favoritesList.querySelectorAll("[data-favorite-remove]").forEach((button) => {
    button.addEventListener("click", () => toggleFavorite(button.dataset.stopId, button.dataset.routeKey));
  });
}

function renderRecents() {
  elements.recentSection.classList.toggle("hidden", state.recents.length === 0);
  elements.recentList.innerHTML = state.recents.map((item) => `
    <div class="favorite-card">
      ${storedRouteButton(item, "data-recent-open")}
    </div>`).join("");

  elements.recentList.querySelectorAll("[data-recent-open]").forEach((button) => {
    button.addEventListener("click", () => openStoredRoute(button.dataset.stopId, button.dataset.routeKey, state.recents));
  });
}

function storedRouteButton(item, dataAttribute) {
  return `<button class="route-button" type="button" ${dataAttribute} data-stop-id="${escapeHtml(item.stop_id)}" data-route-key="${escapeHtml(item.route_key)}">
    <span class="route-name">${escapeHtml(item.route_name || "系統")}</span>
    <span class="route-headsign">${escapeHtml(item.stop_name)} → ${escapeHtml(displayHeadsign(item.headsign))}</span>
    <span aria-hidden="true">↗</span>
  </button>`;
}

function openStoredRoute(stopId, routeKey, collection) {
  const stored = collection.find((item) => item.stop_id === stopId && item.route_key === routeKey);
  const stop = findStop(stopId) || stored;
  const route = findRoute(stop, routeKey) || stored;
  recordRecent(stop, route);
  openOfficial(stop, route, showToast);
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
  return [route?.route_id || "", route?.route_name || "", route?.headsign || "", route?.direction_id ?? ""].join("|");
}

function deduplicateRoutes(stopId, routes) {
  const seen = new Set();
  return routes.filter((route) => {
    const key = createRouteKey(route);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => {
    const keyA = createRouteKey(a);
    const keyB = createRouteKey(b);
    const favoriteDifference = Number(isFavorite(stopId, keyB)) - Number(isFavorite(stopId, keyA));
    if (favoriteDifference) return favoriteDifference;
    const recentDifference = recentRank(stopId, keyA) - recentRank(stopId, keyB);
    if (recentDifference) return recentDifference;
    return String(a.route_name).localeCompare(String(b.route_name), "ja")
      || String(a.headsign).localeCompare(String(b.headsign), "ja");
  });
}

function isFavorite(stopId, routeKey) {
  return state.favorites.some((item) => item.stop_id === stopId && item.route_key === routeKey);
}

function isRecent(stopId, routeKey) {
  return state.recents.some((item) => item.stop_id === stopId && item.route_key === routeKey);
}

function recentRank(stopId, routeKey) {
  const index = state.recents.findIndex((item) => item.stop_id === stopId && item.route_key === routeKey);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function createStoredRoute(stop, route) {
  return {
    stop_id: stop.stop_id,
    stop_name: stop.stop_name,
    platform_code: stop.platform_code || "",
    route_key: createRouteKey(route),
    route_id: route.route_id || "",
    route_name: route.route_name || "",
    headsign: route.headsign || "",
    direction_id: route.direction_id ?? "",
    official_url: route.official_url || stop.official_url || "",
    at: Date.now(),
  };
}

function recordRecent(stop, route) {
  if (!stop || !route) return;
  const item = createStoredRoute(stop, route);
  state.recents = state.recents.filter((recent) => !(recent.stop_id === item.stop_id && recent.route_key === item.route_key));
  state.recents.unshift(item);
  state.recents = state.recents.slice(0, 8);
  saveArray("tobus-navi-recents", state.recents);
  localStorage.removeItem("tobus-navi-recent");
  renderRecents();
}

function hydrateStoredRoutes(items) {
  return (items || []).map((item) => {
    const stop = findStop(item.stop_id);
    const route = findRoute(stop, item.route_key);
    if (!stop || !route) return item;
    return { ...createStoredRoute(stop, route), at: item.at || Date.now() };
  }).filter((item) => item.stop_id && item.route_key);
}

function loadRecents() {
  const current = loadArray("tobus-navi-recents");
  if (current.length) return current;
  try {
    const old = JSON.parse(localStorage.getItem("tobus-navi-recent") || "null");
    return old && old.stop_id ? [old] : [];
  } catch {
    return [];
  }
}

function loadArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveArray(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function formatDatasetDate(value) {
  if (!value) return "不明";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
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

function setDataControlsEnabled(enabled) {
  elements.locateButton.disabled = !enabled;
  elements.refreshButton.disabled = !enabled;
  elements.radiusSelect.disabled = !enabled;
  elements.manualSearchInput.disabled = !enabled;
  elements.manualSearchForm.querySelector("button[type='submit']").disabled = !enabled;
}

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 4200);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[char]);
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
