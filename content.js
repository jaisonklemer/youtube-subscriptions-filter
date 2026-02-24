(() => {
  "use strict";

  const MODES = {
    ALL: "all",
    VIDEOS: "videos",
    LIVES: "lives"
  };

  const MODE_STORAGE_KEY = "ytSubscriptionsFilterMode";
  const DEFAULT_MODE = MODES.VIDEOS;
  const STYLE_ID = "yt-subscriptions-filter-style";
  const CONTROL_ID = "yt-subscriptions-filter-controls";
  const HIDDEN_COLLAPSE_CLASS = "yt-subscriptions-filter-hidden-collapse";
  const ITEM_SELECTOR = "ytd-rich-item-renderer, ytd-grid-video-renderer";
  const VIDEO_LINK_SELECTOR = [
    'a[href*="/watch?v="]',
    'a[href*="youtube.com/watch?v="]',
    'a[href*="/shorts/"]'
  ].join(",");
  const STRUCTURAL_LIVE_SELECTOR = [
    'ytd-thumbnail-overlay-time-status-renderer[overlay-style="LIVE"]',
    'ytd-thumbnail-overlay-time-status-renderer[overlay-style="UPCOMING"]',
    'yt-thumbnail-view-model [class*="badge-shape--live"]',
    'yt-thumbnail-view-model [class*="badge-shape--upcoming"]'
  ].join(",");
  const LIVE_CHECK_WORKERS = 4;
  const LIVE_CHECK_MAX_CACHE = 1200;
  const LIVE_CHECK_MAX_QUEUE = 800;
  const INNERTUBE_CONFIG_EVENT = "yt-subs-filter-innertube-config";
  const FILTER_BUTTON_BASE_CLASS = [
    "yt-spec-button-shape-next",
    "yt-spec-button-shape-next--tonal",
    "yt-spec-button-shape-next--mono",
    "yt-spec-button-shape-next--size-m",
    "yt-spec-button-shape-next--enable-backdrop-filter-experiment",
    "yt-subscriptions-filter-chip"
  ].join(" ");
  const DEBUG = false;
  const LOG_PREFIX = "[YT Subs Filter]";

  let currentMode = DEFAULT_MODE;
  let refreshQueued = false;
  let applyQueued = false;
  let rootObserver = null;
  let feedObserver = null;
  let observedFeed = null;
  let lastFilterSummary = "";
  let lastPathname = location.pathname;
  let lastHostSignature = "";
  let liveWorkersActive = 0;
  let lastInnertubeRequestAt = 0;
  let pageInnertubeConfig = null;
  let innertubeBridgeReady = false;
  let scriptConfigScanned = false;
  const liveClassificationCache = new Map();
  const liveCheckQueue = [];
  const liveCheckQueued = new Set();

  function debugLog(...args) {
    if (!DEBUG) {
      return;
    }
    console.log(LOG_PREFIX, ...args);
  }

  function debugWarn(...args) {
    if (!DEBUG) {
      return;
    }
    console.warn(LOG_PREFIX, ...args);
  }

  function isSubscriptionsPage() {
    return location.pathname === "/feed/subscriptions";
  }

  function isNodeVisible(node) {
    if (!node || !node.isConnected) {
      return false;
    }
    if (node.closest("[hidden]")) {
      return false;
    }
    return node.getClientRects().length > 0;
  }

  function getActiveBrowseRoot() {
    const browses = Array.from(document.querySelectorAll("ytd-browse"));
    if (browses.length === 0) {
      return document;
    }

    const visibleBrowses = browses.filter(isNodeVisible);
    if (visibleBrowses.length === 0) {
      return browses[0];
    }

    const subscriptionsBrowse = visibleBrowses.find(
      (node) => node.getAttribute("page-subtype") === "subscriptions"
    );
    if (subscriptionsBrowse) {
      return subscriptionsBrowse;
    }

    return visibleBrowses[0];
  }

  function firstVisible(root, selector) {
    const matches = Array.from(root.querySelectorAll(selector));
    return matches.find(isNodeVisible) || null;
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${CONTROL_ID} {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        padding: 8px 0 4px;
      }

      #${CONTROL_ID}.yt-subscriptions-filter-inline {
        padding: 0;
        margin-right: 8px;
        flex-wrap: nowrap;
      }

      #${CONTROL_ID} .yt-subscriptions-filter-chip {
        cursor: pointer;
        white-space: nowrap;
        min-width: max-content;
        max-width: none !important;
        flex: 0 0 auto;
        overflow: visible !important;
        text-overflow: clip !important;
      }

      #${CONTROL_ID} .yt-subscriptions-filter-chip .yt-spec-button-shape-next__button-text-content,
      #${CONTROL_ID} .yt-subscriptions-filter-chip .yt-core-attributed-string {
        overflow: visible !important;
        text-overflow: clip !important;
        white-space: nowrap !important;
        max-width: none !important;
      }

      #${CONTROL_ID} .yt-subscriptions-filter-chip.is-active {
        background: var(--yt-spec-static-brand-black, #0f0f0f);
        color: var(--yt-spec-static-brand-white, #fff);
      }

      #${CONTROL_ID} .yt-subscriptions-filter-chip:hover {
        filter: brightness(0.96);
      }

      html[dark] #${CONTROL_ID} .yt-subscriptions-filter-chip {
        filter: none;
      }

      html[dark] #${CONTROL_ID} .yt-subscriptions-filter-chip.is-active {
        background: var(--yt-spec-static-brand-white, #fff);
        color: var(--yt-spec-static-brand-black, #0f0f0f);
      }

      html[dark] #${CONTROL_ID} .yt-subscriptions-filter-chip:hover {
        filter: brightness(1.08);
      }

      .${HIDDEN_COLLAPSE_CLASS} {
        display: none !important;
      }

      #subscribe-button.yt-subscriptions-filter-host {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: nowrap;
      }

      #subscribe-button.yt-subscriptions-filter-host > ytd-button-renderer {
        margin: 0;
      }
    `;

    document.documentElement.appendChild(style);
  }

  function getSubscriptionsAllButtonHost() {
    const root = getActiveBrowseRoot();
    const feedChannelsLink = firstVisible(root, 'a[href*="/feed/channels"]');
    if (feedChannelsLink) {
      const host = feedChannelsLink.closest("#subscribe-button");
      if (host && isNodeVisible(host)) {
        return host;
      }
    }

    const fallbackHosts = Array.from(
      root.querySelectorAll("ytd-shelf-renderer #subscribe-button")
    ).filter(isNodeVisible);
    if (fallbackHosts.length === 0) {
      return null;
    }

    fallbackHosts.sort(
      (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top
    );
    return fallbackHosts[0];
  }

  function getFeedContainer() {
    const root = getActiveBrowseRoot();
    return (
      firstVisible(root, "ytd-rich-grid-renderer #contents") ||
      firstVisible(root, "ytd-section-list-renderer #contents")
    );
  }

  function getItems(container) {
    if (!container) {
      return [];
    }
    return Array.from(container.querySelectorAll(ITEM_SELECTOR));
  }

  function extractVideoIdFromHref(href) {
    if (!href) {
      return null;
    }

    try {
      const url = new URL(href, location.origin);
      if (url.pathname.startsWith("/watch")) {
        return url.searchParams.get("v");
      }
      if (url.pathname.startsWith("/shorts/")) {
        const parts = url.pathname.split("/").filter(Boolean);
        return parts[1] || null;
      }
    } catch {
      return null;
    }

    return null;
  }

  function getVideoIdFromItem(item) {
    const link = item.querySelector(VIDEO_LINK_SELECTOR);
    if (!link) {
      return null;
    }
    return extractVideoIdFromHref(link.href || link.getAttribute("href"));
  }

  function pruneLiveCacheIfNeeded() {
    if (liveClassificationCache.size <= LIVE_CHECK_MAX_CACHE) {
      return;
    }

    const overflow = liveClassificationCache.size - LIVE_CHECK_MAX_CACHE;
    const keys = liveClassificationCache.keys();
    for (let i = 0; i < overflow; i += 1) {
      const key = keys.next().value;
      if (key) {
        liveClassificationCache.delete(key);
      }
    }
  }

  function isValidInnertubeConfig(config) {
    return Boolean(config?.apiKey && config?.context);
  }

  function tryReadInnertubeConfigFromScripts() {
    if (scriptConfigScanned) {
      return null;
    }
    scriptConfigScanned = true;

    const scripts = Array.from(document.scripts || []);
    for (const script of scripts) {
      const text = script.textContent || "";
      if (!text.includes("INNERTUBE_API_KEY")) {
        continue;
      }

      const keyMatch = text.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
      if (!keyMatch) {
        continue;
      }

      const versionMatch = text.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/);
      const hlMatch = text.match(/"HL"\s*:\s*"([^"]+)"/);
      const glMatch = text.match(/"GL"\s*:\s*"([^"]+)"/);

      return {
        apiKey: keyMatch[1],
        context: {
          client: {
            clientName: "WEB",
            clientVersion: versionMatch ? versionMatch[1] : "2.20260101.00.00",
            hl: hlMatch ? hlMatch[1] : (document.documentElement.lang || "en"),
            gl: glMatch ? glMatch[1] : "US"
          }
        }
      };
    }

    return null;
  }

  function requestInnertubeConfigFromPage(force = false) {
    const now = Date.now();
    if (!force && now - lastInnertubeRequestAt < 5000) {
      return;
    }
    lastInnertubeRequestAt = now;

    const script = document.createElement("script");
    script.textContent = `(() => {
      try {
        const ytcfg = window.ytcfg;
        const apiKey = ytcfg && ytcfg.get ? ytcfg.get("INNERTUBE_API_KEY") : null;
        const context = ytcfg && ytcfg.get ? ytcfg.get("INNERTUBE_CONTEXT") : null;
        window.dispatchEvent(new CustomEvent("${INNERTUBE_CONFIG_EVENT}", { detail: { apiKey, context } }));
      } catch (error) {
        window.dispatchEvent(new CustomEvent("${INNERTUBE_CONFIG_EVENT}", { detail: null }));
      }
    })();`;

    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();
  }

  function getInnertubeConfig() {
    if (isValidInnertubeConfig(pageInnertubeConfig)) {
      return pageInnertubeConfig;
    }

    const parsedConfig = tryReadInnertubeConfigFromScripts();
    if (isValidInnertubeConfig(parsedConfig)) {
      pageInnertubeConfig = parsedConfig;
      debugLog("Innertube config captured from scripts");
      return pageInnertubeConfig;
    }

    requestInnertubeConfigFromPage();
    return null;
  }

  function setupInnertubeConfigBridge() {
    if (innertubeBridgeReady) {
      return;
    }

    innertubeBridgeReady = true;
    window.addEventListener(INNERTUBE_CONFIG_EVENT, (event) => {
      const detail = event?.detail;
      if (!isValidInnertubeConfig(detail)) {
        return;
      }

      const changed =
        pageInnertubeConfig?.apiKey !== detail.apiKey ||
        JSON.stringify(pageInnertubeConfig?.context) !== JSON.stringify(detail.context);
      pageInnertubeConfig = { apiKey: detail.apiKey, context: detail.context };
      if (changed) {
        debugLog("Innertube config captured");
        pumpLiveChecks();
      }
    });

    requestInnertubeConfigFromPage(true);
  }

  function classifyFromPlayerResponse(payload) {
    const details = payload?.videoDetails || {};
    const liveDetails = payload?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;

    if (details.isLive === true || details.isUpcoming === true) {
      return true;
    }

    if (details.isLiveContent === true) {
      return true;
    }

    if (payload?.playabilityStatus?.liveStreamability) {
      return true;
    }

    if (liveDetails && (liveDetails.startTimestamp || liveDetails.endTimestamp)) {
      return true;
    }

    return false;
  }

  async function fetchLiveClassification(videoId, config) {
    const endpoint = `https://www.youtube.com/youtubei/v1/player?key=${config.apiKey}`;
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        context: config.context,
        videoId
      })
    });

    if (!response.ok) {
      throw new Error(`player endpoint failed: ${response.status}`);
    }

    const payload = await response.json();
    return classifyFromPlayerResponse(payload);
  }

  function pumpLiveChecks() {
    const config = getInnertubeConfig();
    if (!config) {
      return;
    }

    while (liveWorkersActive < LIVE_CHECK_WORKERS && liveCheckQueue.length > 0) {
      const videoId = liveCheckQueue.shift();
      if (!videoId) {
        break;
      }

      liveWorkersActive += 1;
      fetchLiveClassification(videoId, config)
        .then((isLiveContent) => {
          liveClassificationCache.set(videoId, { isLive: isLiveContent });
          pruneLiveCacheIfNeeded();
        })
        .catch((error) => {
          liveClassificationCache.set(videoId, { isLive: false });
          pruneLiveCacheIfNeeded();
          debugWarn("Live classification failed for", videoId, error);
        })
        .finally(() => {
          liveWorkersActive -= 1;
          liveCheckQueued.delete(videoId);
          queueApply();
          pumpLiveChecks();
        });
    }
  }

  function queueLiveCheck(videoId) {
    if (!videoId) {
      return;
    }
    if (liveClassificationCache.has(videoId) || liveCheckQueued.has(videoId)) {
      return;
    }

    if (liveCheckQueue.length >= LIVE_CHECK_MAX_QUEUE) {
      const dropped = liveCheckQueue.shift();
      if (dropped) {
        liveCheckQueued.delete(dropped);
      }
    }

    liveCheckQueued.add(videoId);
    liveCheckQueue.push(videoId);
    pumpLiveChecks();
  }

  function isLiveOrStreamItem(item) {
    if (item.querySelector(STRUCTURAL_LIVE_SELECTOR)) {
      return true;
    }

    const videoId = getVideoIdFromItem(item);
    if (!videoId) {
      return false;
    }

    const cached = liveClassificationCache.get(videoId);
    if (cached) {
      return cached.isLive;
    }

    queueLiveCheck(videoId);
    return null;
  }

  function applyFilterToItem(item) {
    const liveState = isLiveOrStreamItem(item);
    const isLive = liveState === true;
    const isKnown = liveState !== null;
    const hide =
      currentMode === MODES.VIDEOS
        ? isLive
        : currentMode === MODES.LIVES
          ? isKnown && !isLive
          : false;

    item.classList.remove(HIDDEN_COLLAPSE_CLASS);
    if (hide) {
      item.classList.add(HIDDEN_COLLAPSE_CLASS);
    }

    return { isLive, hidden: hide, known: isKnown };
  }

  function applyFilter() {
    if (!isSubscriptionsPage()) {
      return;
    }

    const container = getFeedContainer();
    const items = getItems(container);
    let liveCount = 0;
    let hiddenCount = 0;
    let unknownCount = 0;

    for (const item of items) {
      const { isLive, hidden, known } = applyFilterToItem(item);
      if (isLive) {
        liveCount += 1;
      }
      if (hidden) {
        hiddenCount += 1;
      }
      if (!known) {
        unknownCount += 1;
      }
    }

    const summary = `mode=${currentMode} total=${items.length} lives=${liveCount} hidden=${hiddenCount} unknown=${unknownCount}`;
    if (summary !== lastFilterSummary) {
      lastFilterSummary = summary;
      debugLog("applyFilter", summary);
    }
  }

  function queueApply() {
    if (applyQueued) {
      return;
    }

    applyQueued = true;
    requestAnimationFrame(() => {
      applyQueued = false;
      applyFilter();
    });
  }

  function setMode(nextMode) {
    if (!Object.values(MODES).includes(nextMode)) {
      debugWarn("Invalid mode ignored:", nextMode);
      return;
    }

    if (currentMode === nextMode) {
      return;
    }

    debugLog("Mode changed:", currentMode, "->", nextMode);
    currentMode = nextMode;
    updateButtons();
    queueApply();

    if (chrome?.storage?.local) {
      chrome.storage.local.set({ [MODE_STORAGE_KEY]: currentMode });
    }
  }

  function buildButton(mode, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = FILTER_BUTTON_BASE_CLASS;
    button.dataset.mode = mode;

    const textWrap = document.createElement("div");
    textWrap.className = "yt-spec-button-shape-next__button-text-content";
    const text = document.createElement("span");
    text.className =
      "yt-core-attributed-string yt-core-attributed-string--white-space-no-wrap";
    text.textContent = label;
    textWrap.appendChild(text);
    button.appendChild(textWrap);

    button.addEventListener("click", () => setMode(mode));
    return button;
  }

  function updateButtons() {
    const controls = document.getElementById(CONTROL_ID);
    if (!controls) {
      return;
    }

    const buttons = controls.querySelectorAll("button[data-mode]");
    for (const button of buttons) {
      const isActive = button.dataset.mode === currentMode;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    }
  }

  function ensureControls() {
    if (!isSubscriptionsPage()) {
      const staleControls = document.getElementById(CONTROL_ID);
      if (staleControls) {
        debugLog("Removing controls outside subscriptions page");
        staleControls.remove();
      }
      return;
    }

    injectStyles();

    const subscribeHost = getSubscriptionsAllButtonHost();
    const hostSignature = `subscribe=${subscribeHost ? subscribeHost.tagName.toLowerCase() : "none"}`;
    if (hostSignature !== lastHostSignature) {
      lastHostSignature = hostSignature;
      debugLog("Resolved hosts:", hostSignature);
    }

    // Prevent top-of-page fallback insertion to avoid visible flicker.
    // Insert only when the "All subscriptions" host is available.
    if (!subscribeHost) {
      return;
    }

    let controls = document.getElementById(CONTROL_ID);
    if (!controls) {
      controls = document.createElement("div");
      controls.id = CONTROL_ID;

      controls.appendChild(buildButton(MODES.ALL, "All"));
      controls.appendChild(buildButton(MODES.VIDEOS, "Published videos"));
      controls.appendChild(buildButton(MODES.LIVES, "Live"));
    }

    if (subscribeHost) {
      subscribeHost.classList.add("yt-subscriptions-filter-host");
      controls.classList.add("yt-subscriptions-filter-inline");
      const subscribeButton = firstVisible(
        subscribeHost,
        "ytd-button-renderer, yt-button-shape, a[href]"
      );

      const alreadyPlaced = subscribeButton
        ? controls.parentElement === subscribeHost &&
          controls.nextElementSibling === subscribeButton
        : controls.parentElement === subscribeHost &&
          controls === subscribeHost.firstElementChild;

      if (!alreadyPlaced) {
        if (subscribeButton) {
          subscribeButton.insertAdjacentElement("beforebegin", controls);
        } else {
          subscribeHost.append(controls);
        }
        debugLog("Filter controls inserted beside 'All subscriptions'");
      }

      updateButtons();
      return;
    }
  }

  function disconnectFeedObserver() {
    if (feedObserver) {
      feedObserver.disconnect();
      feedObserver = null;
      debugLog("Feed observer disconnected");
    }
    observedFeed = null;
  }

  function stopRootObserver() {
    if (rootObserver) {
      rootObserver.disconnect();
      rootObserver = null;
      debugLog("Root observer stopped");
    }
  }

  function ensureFeedObserver() {
    const feed = getFeedContainer();

    if (!feed) {
      disconnectFeedObserver();
      return;
    }

    if (feedObserver && observedFeed === feed) {
      return;
    }

    disconnectFeedObserver();

    observedFeed = feed;
    feedObserver = new MutationObserver(() => {
      queueApply();
    });

    feedObserver.observe(feed, {
      childList: true,
      subtree: true
    });
    debugLog("Feed observer attached");
  }

  function refresh() {
    if (location.pathname !== lastPathname) {
      debugLog("Route changed:", lastPathname, "->", location.pathname);
      lastPathname = location.pathname;
      scriptConfigScanned = false;
    }

    if (!isSubscriptionsPage()) {
      disconnectFeedObserver();
      stopRootObserver();
      ensureControls();
      return;
    }

    if (!isValidInnertubeConfig(pageInnertubeConfig)) {
      requestInnertubeConfigFromPage();
    }

    startRootObserver();
    ensureControls();
    ensureFeedObserver();
    queueApply();
  }

  function queueRefresh() {
    if (refreshQueued) {
      return;
    }

    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      refresh();
    });
  }

  function wireNavigationHooks() {
    document.addEventListener("yt-navigate-finish", queueRefresh, true);
    window.addEventListener("popstate", queueRefresh, true);

    debugLog("Navigation hooks wired");
  }

  function startRootObserver() {
    if (rootObserver) {
      return;
    }

    rootObserver = new MutationObserver(() => {
      queueRefresh();
    });

    rootObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    debugLog("Root observer started");
  }

  function loadModeAndStart() {
    if (!chrome?.storage?.local) {
      queueRefresh();
      return;
    }

    chrome.storage.local.get({ [MODE_STORAGE_KEY]: DEFAULT_MODE }, (result) => {
      const loadedMode = result[MODE_STORAGE_KEY];
      if (Object.values(MODES).includes(loadedMode)) {
        currentMode = loadedMode;
      }
      debugLog("Initial mode loaded:", currentMode);
      queueRefresh();
    });
  }

  debugLog("Script bootstrapped");
  setupInnertubeConfigBridge();
  wireNavigationHooks();
  loadModeAndStart();
})();
