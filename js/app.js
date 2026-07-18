import {
  getCurrentPosition,
  getGeolocationPermissionState,
  geolocationErrorMessage,
  formatDistance,
} from "./geo.js";
import {
  loadDataset,
  loadRouteData,
  nearbyStopGroups,
  searchStopGroups,
} from "./data.js";
import {
  displayHeadsign,
  formatPlatformLabel,
  destinationLabelsForPlatform,
  destinationSummaryForGroup,
} from "./display.js";
import { buildSuggestionIndex, suggestSearchTerms, suggestionTypeLabel } from "./suggest.js";
import {
  currentTokyoDateKey,
  formatGtfsClock,
  formatTimestampClock,
  getDailyTimetable,
  getUpcomingDepartures,
  minutesUntil,
} from "./timetable.js";
import {
  buildFutureStopEstimates,
  fetchRealtimeVehicles,
  getApproachingVehicles,
  isRealtimeFeedStale,
  realtimeFeedAgeMs,
  realtimeStatusLabel,
  vehicleLocationLabel,
} from "./realtime.js";
import {
  REALTIME_MAX_BACKOFF_MS,
  REALTIME_REFRESH_MS,
  REALTIME_SOURCES,
  REALTIME_STALE_AFTER_MS,
  REALTIME_TIMEOUT_MS,
  REALTIME_VEHICLE_MAX_AGE_MS,
} from "./config.js";

const elements = Object.fromEntries([
  "locateButton", "refreshButton", "radiusSelect", "manualSearchForm", "manualSearchInput",
  "searchSuggestions", "results", "resultsList", "resultCount", "resultsEyebrow",
  "statusPanel", "statusTitle", "statusMessage", "statusIcon", "datasetSummary", "toast",
  "favoritesSection", "favoritesList", "clearFavoritesButton", "recentSection", "recentList",
  "clearRecentButton", "installButton", "aboutButton", "closeAboutButton", "aboutDialog",
  "datasetLabel", "datasetUpdatedAt", "routeDetail", "routeDetailEyebrow", "routeDetailTitle",
  "routeDetailSubtitle", "routeDetailStatus", "closeDetailButton", "refreshRealtimeButton",
  "liveBusList", "vehicleTrackingSection", "closeTrackingButton", "vehicleSummary",
  "futureStopsList", "upcomingDepartures", "dailyTimetable", "timetableDate",
  "timetableDetails", "timetableSummaryLabel",
].map((id) => [id, document.querySelector(`#${id}`)]));

elements.resultsTitle = document.querySelector("#results-title");

const state = {
  dataset: { meta: {}, stop_groups: [], routes: {} },
  suggestionIndex: [],
  suggestions: [],
  activeSuggestionIndex: -1,
  lastPosition: null,
  deferredInstallPrompt: null,
  currentView: { groups: [], showDistance: false },
  favorites: loadArray("tobus-navi-favorites-v4"),
  recents: loadArray("tobus-navi-recents-v4"),
  routeCache: new Map(),
  activeSelection: null,
  activeRouteData: null,
  realtimeFeed: null,
  realtimeTimer: null,
  selectedVehicleId: null,
  timetableRenderedKey: "",
  realtimeFailureCount: 0,
  realtimeInFlight: false,
  realtimeGeneration: 0,
  openStopGroups: new Set(),
};

init();

async function init() {
  bindEvents();
  registerServiceWorker();
  try {
    state.dataset = await loadDataset();
    state.suggestionIndex = buildSuggestionIndex(state.dataset.stop_groups);
    const meta = state.dataset.meta || {};
    const generatedAt = formatDatasetDate(meta.generated_at);
    elements.datasetLabel.textContent = `${meta.dataset_name || "都バスGTFS-JP"}（${state.dataset.stop_groups.length}停留所名）`;
    elements.datasetUpdatedAt.textContent = generatedAt;
    elements.datasetSummary.textContent = `データ生成：${generatedAt}`;
    hydrateStoredCollections();
    renderFavorites();
    renderRecents();
    await prepareInitialLocationSearch();
  } catch (error) {
    console.error(error);
    setDataControlsEnabled(false);
    elements.datasetLabel.textContent = "正式データを読み込めませんでした";
    elements.datasetUpdatedAt.textContent = "未取得";
    setStatus("error", "交通データを利用できません", error.message);
    elements.datasetSummary.textContent = "Phase 6変換スクリプトで data/transit-index.json と data/routes/ を生成してください。";
  }
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
    if (state.activeSuggestionIndex >= 0) selectSuggestion(state.activeSuggestionIndex);
    else runManualSearch(elements.manualSearchInput.value);
  });
  elements.manualSearchInput.addEventListener("input", updateSuggestions);
  elements.manualSearchInput.addEventListener("focus", updateSuggestions);
  elements.manualSearchInput.addEventListener("keydown", handleSuggestionKeydown);
  elements.manualSearchInput.addEventListener("blur", () => window.setTimeout(hideSuggestions, 150));

  elements.clearFavoritesButton.addEventListener("click", () => {
    state.favorites = [];
    saveArray("tobus-navi-favorites-v4", state.favorites);
    renderFavorites();
    rerenderCurrentView();
  });
  elements.clearRecentButton.addEventListener("click", () => {
    state.recents = [];
    saveArray("tobus-navi-recents-v4", state.recents);
    renderRecents();
  });
  elements.aboutButton.addEventListener("click", () => elements.aboutDialog.showModal());
  elements.closeAboutButton.addEventListener("click", () => elements.aboutDialog.close());
  elements.installButton.addEventListener("click", installPwa);
  elements.closeDetailButton.addEventListener("click", closeRouteDetail);
  elements.refreshRealtimeButton.addEventListener("click", () => refreshRealtime(true));
  elements.closeTrackingButton.addEventListener("click", () => {
    state.selectedVehicleId = null;
    renderVehicleTracking([]);
  });
  elements.timetableDetails.addEventListener("toggle", () => {
    elements.timetableSummaryLabel.textContent = elements.timetableDetails.open ? "時刻表を閉じる" : "時刻表を開く";
    if (elements.timetableDetails.open) renderDailyTimetable();
  });
  window.addEventListener("online", () => {
    if (!state.activeSelection) return;
    state.realtimeFailureCount = 0;
    showToast("通信が復旧しました。車両位置を更新します。");
    refreshRealtime(true);
  });
  window.addEventListener("offline", () => {
    clearRealtimeTimer();
    if (state.activeSelection) {
      elements.routeDetailStatus.textContent = "オフラインです。時刻表は利用できますが、車両位置は更新できません。";
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!state.activeSelection) return;
    if (document.hidden) clearRealtimeTimer();
    else refreshRealtime(false);
  });
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    elements.installButton.classList.remove("hidden");
  });
}

async function prepareInitialLocationSearch() {
  const count = state.dataset.stop_groups.length;
  const permissionState = await getGeolocationPermissionState();
  if (permissionState === "granted") {
    await locateAndSearch();
  } else if (permissionState === "denied") {
    setStatus("warning", "位置情報が無効です", `${count}件の停留所名を読み込みました。ブラウザ設定で許可するか検索欄を使用してください。`);
  } else {
    setStatus("success", "準備できました", `${count}件の停留所名を読み込みました。「現在地から検索」をタップしてください。`);
  }
}

function updateSuggestions() {
  const query = elements.manualSearchInput.value.trim();
  state.suggestions = suggestSearchTerms(state.suggestionIndex, query, 8);
  state.activeSuggestionIndex = -1;
  renderSuggestions();
}

function renderSuggestions() {
  if (!state.suggestions.length) return hideSuggestions();
  elements.searchSuggestions.innerHTML = state.suggestions.map((item, index) => `
    <button id="suggestion-option-${index}" class="suggestion-item" type="button" role="option"
      data-suggestion-index="${index}" aria-selected="false">
      <span class="suggestion-type">${escapeHtml(suggestionTypeLabel(item.type))}</span>
      <span class="suggestion-value">${escapeHtml(item.value)}</span>
    </button>`).join("");
  elements.searchSuggestions.querySelectorAll("[data-suggestion-index]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => selectSuggestion(Number(button.dataset.suggestionIndex)));
  });
  elements.searchSuggestions.classList.remove("hidden");
  elements.manualSearchInput.setAttribute("aria-expanded", "true");
}

function handleSuggestionKeydown(event) {
  if (!state.suggestions.length) {
    if (event.key === "Escape") hideSuggestions();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    state.activeSuggestionIndex = (state.activeSuggestionIndex + 1) % state.suggestions.length;
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    state.activeSuggestionIndex = state.activeSuggestionIndex <= 0 ? state.suggestions.length - 1 : state.activeSuggestionIndex - 1;
  } else if (event.key === "Enter" && state.activeSuggestionIndex >= 0) {
    event.preventDefault();
    selectSuggestion(state.activeSuggestionIndex);
    return;
  } else if (event.key === "Escape") {
    event.preventDefault();
    hideSuggestions();
    return;
  } else return;
  updateActiveSuggestion();
}

function updateActiveSuggestion() {
  elements.searchSuggestions.querySelectorAll("[data-suggestion-index]").forEach((button, index) => {
    const active = index === state.activeSuggestionIndex;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    if (active) button.scrollIntoView({ block: "nearest" });
  });
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
}

function runManualSearch(rawQuery, sourceLabel = "キーワード検索") {
  const query = String(rawQuery || "").trim();
  if (!query) return showToast("停留所名、系統番号、または行き先を入力してください。");
  const matches = searchStopGroups(state.dataset.stop_groups, query);
  elements.resultsTitle.textContent = `「${query}」の検索結果`;
  elements.resultsEyebrow.textContent = sourceLabel;
  renderStopGroups(matches, false);
  setStatus(matches.length ? "success" : "warning", matches.length ? "検索しました" : "該当なし",
    matches.length ? `${matches.length}件の停留所名を表示しています。` : "別の検索語を入力してください。");
  elements.results.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function locateAndSearch() {
  if (!state.dataset.stop_groups.length) return;
  setBusy(true);
  setStatus("loading", "現在地を取得しています", "位置情報の許可画面が表示されたら「許可」を選択してください。");
  try {
    const position = await getCurrentPosition();
    state.lastPosition = position;
    renderNearby(position.coords.latitude, position.coords.longitude);
  } catch (error) {
    setStatus("error", "現在地を取得できませんでした", geolocationErrorMessage(error));
  } finally {
    setBusy(false);
  }
}

function renderNearby(latitude, longitude) {
  const radius = Number(elements.radiusSelect.value);
  const matches = nearbyStopGroups(state.dataset.stop_groups, latitude, longitude, radius);
  elements.resultsTitle.textContent = "現在地から近い停留所";
  elements.resultsEyebrow.textContent = `半径 ${radius >= 1000 ? `${radius / 1000} km` : `${radius} m`}`;
  renderStopGroups(matches, true);
  setStatus(matches.length ? "success" : "warning", matches.length ? "周辺検索が完了しました" : "近くに候補がありません",
    matches.length ? `同名の上り・下りをまとめ、${matches.length}件を距離順に表示しています。` : "検索半径を広げてください。");
}

function renderStopGroups(groups, showDistance) {
  state.currentView = { groups, showDistance };
  elements.resultCount.textContent = `${groups.length}件`;
  if (!groups.length) {
    elements.resultsList.innerHTML = `<div class="empty-state"><span aria-hidden="true">🚌</span><p>表示できる停留所がありません。</p></div>`;
    return;
  }

  elements.resultsList.innerHTML = groups.map((group) => {
    const platforms = group.platforms || [];
    const platformCount = platforms.length;
    const destinationSummary = destinationSummaryForGroup(platforms, 4);
    const platformMarkup = platforms.map((platform, index) => (
      platformPanel(group, platform, index, platformCount)
    )).join("");
    const platformSection = platformCount > 1
      ? `<details class="stop-platform-details" data-stop-details data-group-id="${escapeHtml(group.group_id)}" ${state.openStopGroups.has(group.group_id) ? "open" : ""}>
          <summary class="stop-platform-summary">
            <span><span class="closed-label">のりば・系統を表示</span><span class="open-label">のりば・系統を閉じる</span></span>
            <span class="summary-count">${platformCount}か所</span>
          </summary>
          <div class="platform-list platform-tree">${platformMarkup}</div>
        </details>`
      : `<div class="platform-list single-platform-list">${platformMarkup}</div>`;

    return `<article class="stop-card stop-group-card" data-group-id="${escapeHtml(group.group_id)}">
      <div class="stop-header">
        <div class="stop-title-row">
          <h3 class="stop-title">${escapeHtml(group.stop_name)}</h3>
          ${showDistance ? `<span class="distance">${formatDistance(group.distance)}</span>` : ""}
        </div>
        <p class="stop-destination-summary">${escapeHtml(destinationSummary)}</p>
        <div class="stop-meta"><span class="meta-chip">${platformCount}のりば</span></div>
      </div>
      ${platformSection}
    </article>`;
  }).join("");

  elements.resultsList.querySelectorAll("[data-stop-details]").forEach((details) => {
    details.addEventListener("toggle", () => {
      const groupId = details.dataset.groupId;
      if (details.open) state.openStopGroups.add(groupId);
      else state.openStopGroups.delete(groupId);
    });
  });
  elements.resultsList.querySelectorAll("[data-route-action]").forEach((button) => {
    button.addEventListener("click", () => openRouteDetail(button.dataset.groupId, button.dataset.stopId, button.dataset.routeKey));
  });
  elements.resultsList.querySelectorAll("[data-favorite-action]").forEach((button) => {
    button.addEventListener("click", () => toggleFavorite(button.dataset.groupId, button.dataset.stopId, button.dataset.routeKey));
  });
}

function platformPanel(group, platform, index, total) {
  const routes = deduplicateRoutes(platform.routes || []);
  const platformLabel = formatPlatformLabel(platform, index);
  const destinationSummary = destinationLabelsForPlatform(platform, 3);
  const treeGlyph = index === total - 1 ? "└" : "├";
  return `<section class="platform-panel ${index === total - 1 ? "last-platform" : ""}">
    <div class="platform-heading">
      <div class="platform-heading-main">
        <span class="platform-tree-glyph" aria-hidden="true">${treeGlyph}</span>
        <div><strong>${escapeHtml(platformLabel)}</strong><p>${escapeHtml(destinationSummary)}</p></div>
      </div>
      <span class="platform-count">${routes.length}方面</span>
    </div>
    <div class="route-list">${routes.map((route) => routeRow(group, platform, route)).join("") || "<p>系統情報がありません。</p>"}</div>
  </section>`;
}

function routeRow(group, platform, route) {
  const routeKey = createRouteKey(route);
  const favorite = isFavorite(platform.stop_id, routeKey);
  const recent = isRecent(platform.stop_id, routeKey);
  return `<div class="route-row ${favorite ? "priority-route" : ""}">
    <button class="route-button" type="button" data-route-action data-group-id="${escapeHtml(group.group_id)}"
      data-stop-id="${escapeHtml(platform.stop_id)}" data-route-key="${escapeHtml(routeKey)}">
      <span class="route-name">${escapeHtml(route.route_name || "系統")}</span>
      <span class="route-headsign">${escapeHtml(displayHeadsign(route.headsign))}</span>
      ${favorite ? `<span class="route-state">お気に入り</span>` : recent ? `<span class="route-state">最近</span>` : ""}
      <span aria-hidden="true">›</span>
    </button>
    <button class="favorite-button" type="button" data-favorite-action data-group-id="${escapeHtml(group.group_id)}"
      data-stop-id="${escapeHtml(platform.stop_id)}" data-route-key="${escapeHtml(routeKey)}"
      aria-label="お気に入り${favorite ? "から解除" : "に追加"}" aria-pressed="${favorite}">★</button>
  </div>`;
}

async function openRouteDetail(groupId, stopId, routeKey) {
  const selection = resolveSelection(groupId, stopId, routeKey);
  if (!selection) return showToast("選択した系統を見つけられませんでした。");
  clearRealtimeTimer();
  state.activeSelection = selection;
  state.selectedVehicleId = null;
  state.activeRouteData = null;
  state.realtimeFeed = null;
  state.realtimeFailureCount = 0;
  state.realtimeInFlight = false;
  state.realtimeGeneration += 1;
  state.timetableRenderedKey = "";
  elements.timetableDetails.open = false;
  elements.timetableSummaryLabel.textContent = "時刻表を開く";
  recordRecent(selection);
  renderFavorites();
  renderRecents();
  rerenderCurrentView();

  elements.routeDetail.classList.remove("hidden");
  elements.routeDetailEyebrow.textContent = `${selection.platform.platform_code || "のりば"}・運行情報`;
  elements.routeDetailTitle.textContent = `${selection.route.route_name} ${displayHeadsign(selection.route.headsign)}`;
  elements.routeDetailSubtitle.textContent = `${selection.group.stop_name}から乗車`;
  elements.routeDetailStatus.textContent = "時刻表データを読み込んでいます…";
  elements.liveBusList.innerHTML = loadingMarkup("リアルタイム情報を準備しています");
  elements.upcomingDepartures.innerHTML = loadingMarkup("発車予定を計算しています");
  elements.dailyTimetable.innerHTML = "";
  renderVehicleTracking([]);
  elements.routeDetail.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    state.activeRouteData = await getRouteData(selection.route.route_file);
    renderStaticSchedule();
    await refreshRealtime(false);
  } catch (error) {
    console.error(error);
    elements.routeDetailStatus.textContent = error.message;
    elements.liveBusList.innerHTML = errorMarkup(error.message);
  }
}

function renderStaticSchedule() {
  const selection = selectionForSchedule();
  const now = new Date();
  const upcoming = getUpcomingDepartures(state.activeRouteData, selection, now, 12);
  elements.routeDetailStatus.textContent = `${state.activeRouteData.route.route_name}の正式GTFS-JP時刻表を表示しています。`;
  elements.timetableDate.textContent = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short" }).format(now);

  elements.upcomingDepartures.innerHTML = upcoming.length ? upcoming.map((departure) => {
    const mins = minutesUntil(departure.departure_ms, now.getTime());
    return `<div class="departure-card"><strong>${formatTimestampClock(departure.departure_ms)}</strong><span>${mins === 0 ? "まもなく" : `あと${mins}分`}</span></div>`;
  }).join("") : `<p class="empty-message">この先30時間以内の発車予定がありません。</p>`;

  elements.dailyTimetable.innerHTML = `<p class="empty-message">「時刻表を開く」をタップすると本日の全便を表示します。</p>`;
  if (elements.timetableDetails.open) renderDailyTimetable();
}

function renderDailyTimetable() {
  if (!state.activeRouteData || !state.activeSelection) return;
  const selection = selectionForSchedule();
  const dateKey = currentTokyoDateKey();
  const renderKey = `${state.activeSelection.platform.stop_id}|${state.activeSelection.routeKey}|${dateKey}`;
  if (state.timetableRenderedKey === renderKey) return;

  const daily = getDailyTimetable(state.activeRouteData, selection, dateKey);
  elements.dailyTimetable.innerHTML = daily.length ? daily.map((departure) => (
    `<span class="time-chip">${formatGtfsClock(departure.scheduled_seconds)}</span>`
  )).join("") : `<p class="empty-message">本日の運行予定がありません。</p>`;
  state.timetableRenderedKey = renderKey;
}

async function refreshRealtime(userRequested = false) {
  if (!state.activeSelection || !state.activeRouteData) return;
  if (state.realtimeInFlight) {
    if (userRequested) showToast("車両位置を更新中です。");
    return;
  }
  clearRealtimeTimer();
  if (!navigator.onLine) {
    elements.routeDetailStatus.textContent = "オフラインです。時刻表は利用できますが、車両位置は更新できません。";
    return;
  }

  const generation = state.realtimeGeneration;
  state.realtimeInFlight = true;
  elements.refreshRealtimeButton.disabled = true;
  if (userRequested) elements.routeDetailStatus.textContent = "車両位置を更新しています…";

  try {
    const feed = await fetchRealtimeVehicles(REALTIME_SOURCES, {
      timeoutMs: REALTIME_TIMEOUT_MS,
      retries: 0,
    });
    if (generation !== state.realtimeGeneration || !state.activeSelection) return;
    state.realtimeFeed = feed;
    state.realtimeFailureCount = 0;
    renderRealtime();
  } catch (error) {
    if (generation !== state.realtimeGeneration || !state.activeSelection) return;
    console.error(error);
    state.realtimeFailureCount += 1;
    const retrySeconds = Math.round(nextRealtimeDelayMs() / 1000);
    elements.routeDetailStatus.textContent = `車両位置を取得できませんでした。${retrySeconds}秒後に再試行します。時刻表は利用できます。`;
    elements.liveBusList.innerHTML = realtimeErrorMarkup(error, retrySeconds);
  } finally {
    if (generation === state.realtimeGeneration) {
      state.realtimeInFlight = false;
      elements.refreshRealtimeButton.disabled = false;
      scheduleRealtimeRefresh();
    }
  }
}

function scheduleRealtimeRefresh() {
  clearRealtimeTimer();
  if (!state.activeSelection || document.hidden || !navigator.onLine) return;
  state.realtimeTimer = window.setTimeout(() => refreshRealtime(false), nextRealtimeDelayMs());
}

function nextRealtimeDelayMs() {
  if (!state.realtimeFailureCount) return REALTIME_REFRESH_MS;
  return Math.min(
    REALTIME_MAX_BACKOFF_MS,
    REALTIME_REFRESH_MS * (2 ** Math.min(state.realtimeFailureCount, 3)),
  );
}

function realtimeErrorMarkup(error, retrySeconds) {
  const attempts = Array.isArray(error?.attempts) ? error.attempts : [];
  const details = attempts.length
    ? `<ul class="realtime-attempts">${attempts.map((attempt) => `<li>${escapeHtml(attempt.label)}：${escapeHtml(attempt.message)}</li>`).join("")}</ul>`
    : `<p>${escapeHtml(error.message || "通信エラーが発生しました。")}</p>`;
  const proxyHint = attempts.some((attempt) => /CORS|ネットワーク/i.test(attempt.message))
    ? `<p>Android Chromeから直接取得できない場合は、同梱のCloudflare Workerを公開し、<code>js/config.js</code>へURLを設定してください。</p>`
    : "";
  return `<div class="realtime-error"><strong>車両位置を取得できません</strong>${details}${proxyHint}<p>${retrySeconds}秒後に自動再試行します。「現在位置を更新」で即時再試行できます。</p></div>`;
}

function renderRealtime() {
  const selection = selectionForSchedule();
  const nowMs = Date.now();
  const vehicles = getApproachingVehicles(state.activeRouteData, selection, state.realtimeFeed, nowMs, {
    maxVehicleAgeMs: REALTIME_VEHICLE_MAX_AGE_MS,
  });
  const feedTime = state.realtimeFeed.timestamp ? formatTimestampClock(state.realtimeFeed.timestamp * 1000) : "不明";
  const sourceLabel = state.realtimeFeed.source?.label || "リアルタイム配信";
  const ageMinutes = Math.ceil(realtimeFeedAgeMs(state.realtimeFeed, nowMs) / 60_000);
  const stale = isRealtimeFeedStale(state.realtimeFeed, nowMs, REALTIME_STALE_AFTER_MS);
  elements.routeDetailStatus.textContent = stale
    ? `位置情報が古い可能性があります（${ageMinutes}分前・${sourceLabel}）。自動再取得を継続します。`
    : `車両位置 ${vehicles.length}台・最終更新 ${feedTime}・${sourceLabel}`;

  if (!vehicles.length) {
    elements.liveBusList.innerHTML = `<p class="empty-message">現在、この停留所へ向かう車両をGTFS-RT上で確認できません。予定時刻表をご利用ください。</p>`;
    renderVehicleTracking([]);
    return;
  }

  elements.liveBusList.innerHTML = vehicles.map((item, index) => {
    const vehicleId = vehicleKey(item.vehicle);
    const label = item.vehicle.vehicle?.label || item.vehicle.vehicle?.id || `バス${index + 1}`;
    const staleClass = isRealtimeFeedStale(state.realtimeFeed, Date.now(), REALTIME_STALE_AFTER_MS) ? "stale" : "";
    return `<button class="live-bus-card ${vehicleId === state.selectedVehicleId ? "selected" : ""} ${staleClass}" type="button" data-vehicle-id="${escapeHtml(vehicleId)}">
      <span class="live-bus-top"><strong>${escapeHtml(label)}</strong><span class="live-status">${escapeHtml(realtimeStatusLabel(item.vehicle.currentStatus))}</span></span>
      <span class="live-location">${escapeHtml(item.currentLabel)}</span>
      <span class="live-eta"><b>${item.minutes === 0 ? "まもなく" : `約${item.minutes}分`}</b>・${item.stopsAway}停留所前</span>
      <span class="live-updated">位置更新 ${escapeHtml(item.updatedAt)}　詳細を見る ›</span>
    </button>`;
  }).join("");

  elements.liveBusList.querySelectorAll("[data-vehicle-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedVehicleId = button.dataset.vehicleId;
      renderRealtime();
    });
  });

  if (state.selectedVehicleId) renderVehicleTracking(vehicles);
}

function renderVehicleTracking(vehicles) {
  if (!state.selectedVehicleId || !vehicles.length) {
    elements.vehicleTrackingSection.classList.add("hidden");
    elements.futureStopsList.innerHTML = "";
    return;
  }
  const selected = vehicles.find((item) => vehicleKey(item.vehicle) === state.selectedVehicleId);
  if (!selected) {
    state.selectedVehicleId = null;
    elements.vehicleTrackingSection.classList.add("hidden");
    return;
  }

  const future = buildFutureStopEstimates(selected.vehicle, selected.trip, state.activeRouteData, Date.now(), 18);
  const label = selected.vehicle.vehicle?.label || selected.vehicle.vehicle?.id || "選択したバス";
  elements.vehicleTrackingSection.classList.remove("hidden");
  elements.vehicleSummary.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(vehicleLocationLabel(selected.vehicle, selected.trip, state.activeRouteData))}</span>`;
  elements.futureStopsList.innerHTML = future.map((stop) => `
    <li class="progress-item ${stop.isCurrent ? "current" : ""}">
      <span class="progress-marker" aria-hidden="true"></span>
      <div><strong>${escapeHtml(stop.stop_name)}</strong>${stop.platform_code ? `<small>${escapeHtml(stop.platform_code)}</small>` : ""}</div>
      <span class="progress-time">${stop.minutes === 0 ? "現在付近" : `約${stop.minutes}分`}<small>${formatTimestampClock(stop.eta_ms)}頃</small></span>
    </li>`).join("");
}

function closeRouteDetail() {
  clearRealtimeTimer();
  state.realtimeGeneration += 1;
  state.realtimeInFlight = false;
  state.activeSelection = null;
  state.activeRouteData = null;
  state.selectedVehicleId = null;
  elements.routeDetail.classList.add("hidden");
}

function clearRealtimeTimer() {
  if (state.realtimeTimer) window.clearInterval(state.realtimeTimer);
  state.realtimeTimer = null;
}

function selectionForSchedule() {
  const { platform, route } = state.activeSelection;
  return { stop_id: platform.stop_id, headsign: route.headsign, direction_id: route.direction_id };
}

async function getRouteData(routeFile) {
  if (!state.routeCache.has(routeFile)) state.routeCache.set(routeFile, loadRouteData(routeFile));
  return state.routeCache.get(routeFile);
}

function resolveSelection(groupId, stopId, routeKey) {
  const group = state.dataset.stop_groups.find((item) => item.group_id === groupId);
  const platform = group?.platforms?.find((item) => item.stop_id === stopId);
  const route = platform?.routes?.find((item) => createRouteKey(item) === routeKey);
  return group && platform && route ? { group, platform, route, routeKey } : null;
}

function toggleFavorite(groupId, stopId, routeKey) {
  const index = state.favorites.findIndex((item) => item.stop_id === stopId && item.route_key === routeKey);
  if (index >= 0) {
    state.favorites.splice(index, 1);
    showToast("お気に入りから解除しました。");
  } else {
    const selection = resolveSelection(groupId, stopId, routeKey);
    if (!selection) return;
    state.favorites.unshift(storedSelection(selection));
    state.favorites = state.favorites.slice(0, 20);
    showToast("お気に入りに追加しました。");
  }
  saveArray("tobus-navi-favorites-v4", state.favorites);
  renderFavorites();
  rerenderCurrentView();
}

function recordRecent(selection) {
  const item = storedSelection(selection);
  state.recents = [item, ...state.recents.filter((existing) => !(existing.stop_id === item.stop_id && existing.route_key === item.route_key))].slice(0, 8);
  saveArray("tobus-navi-recents-v4", state.recents);
}

function storedSelection(selection) {
  return {
    group_id: selection.group.group_id,
    stop_name: selection.group.stop_name,
    stop_id: selection.platform.stop_id,
    platform_code: selection.platform.platform_code,
    route_key: selection.routeKey || createRouteKey(selection.route),
    route_id: selection.route.route_id,
    route_file: selection.route.route_file,
    route_name: selection.route.route_name,
    headsign: selection.route.headsign,
    direction_id: selection.route.direction_id,
  };
}

function hydrateStoredCollections() {
  const valid = (item) => Boolean(resolveSelection(item.group_id, item.stop_id, item.route_key));
  state.favorites = state.favorites.filter(valid);
  state.recents = state.recents.filter(valid);
  saveArray("tobus-navi-favorites-v4", state.favorites);
  saveArray("tobus-navi-recents-v4", state.recents);
}

function renderFavorites() {
  elements.favoritesSection.classList.toggle("hidden", state.favorites.length === 0);
  elements.favoritesList.innerHTML = state.favorites.map((item) => storedRouteCard(item, true)).join("");
  bindStoredRouteButtons(elements.favoritesList);
}

function renderRecents() {
  elements.recentSection.classList.toggle("hidden", state.recents.length === 0);
  elements.recentList.innerHTML = state.recents.map((item) => storedRouteCard(item, false)).join("");
  bindStoredRouteButtons(elements.recentList);
}

function storedRouteCard(item, removable) {
  return `<div class="favorite-card">
    <button class="route-button" type="button" data-stored-open data-group-id="${escapeHtml(item.group_id)}" data-stop-id="${escapeHtml(item.stop_id)}" data-route-key="${escapeHtml(item.route_key)}">
      <span class="route-name">${escapeHtml(item.route_name)}</span><span class="route-headsign">${escapeHtml(item.stop_name)} → ${escapeHtml(displayHeadsign(item.headsign))}</span><span>›</span>
    </button>
    ${removable ? `<button class="favorite-button" type="button" data-stored-remove data-group-id="${escapeHtml(item.group_id)}" data-stop-id="${escapeHtml(item.stop_id)}" data-route-key="${escapeHtml(item.route_key)}" aria-label="お気に入りから解除">★</button>` : ""}
  </div>`;
}

function bindStoredRouteButtons(container) {
  container.querySelectorAll("[data-stored-open]").forEach((button) => button.addEventListener("click", () => openRouteDetail(button.dataset.groupId, button.dataset.stopId, button.dataset.routeKey)));
  container.querySelectorAll("[data-stored-remove]").forEach((button) => button.addEventListener("click", () => toggleFavorite(button.dataset.groupId, button.dataset.stopId, button.dataset.routeKey)));
}

function rerenderCurrentView() {
  if (state.currentView.groups.length) renderStopGroups(state.currentView.groups, state.currentView.showDistance);
}

function deduplicateRoutes(routes) {
  const unique = new Map();
  for (const route of routes) unique.set(createRouteKey(route), route);
  return [...unique.values()].sort((a, b) => {
    const favoriteDifference = Number(isFavorite("", createRouteKey(b))) - Number(isFavorite("", createRouteKey(a)));
    return favoriteDifference || String(a.route_name).localeCompare(String(b.route_name), "ja") || String(a.headsign).localeCompare(String(b.headsign), "ja");
  });
}

function createRouteKey(route) {
  return [route.route_id || "", route.headsign || "", route.direction_id ?? ""].join("|");
}

function isFavorite(stopId, routeKey) {
  return state.favorites.some((item) => (stopId ? item.stop_id === stopId : true) && item.route_key === routeKey);
}

function isRecent(stopId, routeKey) {
  return state.recents.some((item) => item.stop_id === stopId && item.route_key === routeKey);
}

function vehicleKey(vehicle) {
  return vehicle.vehicle?.id || vehicle.entityId || `${vehicle.trip?.tripId}-${vehicle.currentStopSequence}`;
}

function loadingMarkup(message) {
  return `<p class="empty-message">${escapeHtml(message)}…</p>`;
}

function errorMarkup(message) {
  return `<div class="realtime-error"><strong>読み込みに失敗しました</strong><p>${escapeHtml(message)}</p></div>`;
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

function loadArray(key) {
  try { const value = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(value) ? value : []; }
  catch { return []; }
}

function saveArray(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function formatDatasetDate(value) {
  if (!value) return "不明";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

async function installPwa() {
  if (!state.deferredInstallPrompt) return;
  state.deferredInstallPrompt.prompt();
  await state.deferredInstallPrompt.userChoice;
  state.deferredInstallPrompt = null;
  elements.installButton.classList.add("hidden");
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.error);
}
