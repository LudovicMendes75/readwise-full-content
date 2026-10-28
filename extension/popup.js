/**
 * Popup script — handles manual "save this page" and settings UI.
 */

// ============================================================================
// DOM refs
// ============================================================================

const views = {
  save: document.getElementById("view-save"),
  saving: document.getElementById("view-saving"),
  saved: document.getElementById("view-saved"),
  error: document.getElementById("view-error"),
  noPage: document.getElementById("view-no-page"),
};

const els = {
  pageTitle: document.getElementById("page-title"),
  pageUrl: document.getElementById("page-url"),
  saveBtn: document.getElementById("save-btn"),
  retryBtn: document.getElementById("retry-btn"),
  readerLink: document.getElementById("reader-link"),
  errorMessage: document.getElementById("error-message"),
  pollingToggle: document.getElementById("polling-toggle"),
  retryAllBtn: document.getElementById("retry-all-btn"),
  tabExtractionRow: document.getElementById("tab-extraction-row"),
  tabExtractionToggle: document.getElementById("tab-extraction-toggle"),
  pollerStatus: document.getElementById("poller-status"),
  tokenInput: document.getElementById("token-input"),
  saveTokenBtn: document.getElementById("save-token-btn"),
  tokenMissing: document.getElementById("token-missing"),
  lowWordInput: document.getElementById("low-word-input"),
  paywallCount: document.getElementById("paywall-count"),
  completeCount: document.getElementById("complete-count"),
  retryPaywallsBtn: document.getElementById("retry-paywalls-btn"),
  resetCompleteBtn: document.getElementById("reset-complete-btn"),
  manageListBtn: document.getElementById("manage-list-btn"),
};

// Current page state
let currentTab = null;

// Mirrors DEFAULT_LOW_WORD_COUNT / bounds in background.js. Kept here so the
// popup can render a value before the background script answers; the
// background clamps the stored value again on every poll.
const DEFAULT_LOW_WORD_COUNT = 500;
const MIN_LOW_WORD_COUNT = 100;
const MAX_LOW_WORD_COUNT = 1500;

function clampLowWordCount(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_LOW_WORD_COUNT;
  }
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_LOW_WORD_COUNT;
  return Math.min(Math.max(n, MIN_LOW_WORD_COUNT), MAX_LOW_WORD_COUNT);
}

async function refreshBlockedCounts() {
  const { blockedUrls } = await browser.storage.local.get("blockedUrls");
  // Aliases (canonical URL of an already recorded article) are hidden from
  // the counts: one article must not appear twice.
  const entries = Object.values(blockedUrls || {}).filter((e) => !e.aliasOf);
  const paywall = entries.filter((e) => e.reason === "paywall").length;
  const complete = entries.filter((e) => e.reason === "complete").length;
  els.paywallCount.textContent = `${paywall} article${paywall > 1 ? "s" : ""}`;
  els.completeCount.textContent = `${complete} article${complete > 1 ? "s" : ""}`;
}

/**
 * Forget every recorded outcome for one reason, so the next poll retries
 * those URLs from scratch.
 */
async function forgetBlocked(reason) {
  const { blockedUrls, processedUrls } = await browser.storage.local.get([
    "blockedUrls",
    "processedUrls",
  ]);
  const blocked = blockedUrls || {};
  const processed = processedUrls || {};
  for (const [url, entry] of Object.entries(blocked)) {
    if (entry.reason === reason) {
      delete blocked[url];
      // Also drop the 24h cooldown, otherwise the next poll skips the URL.
      delete processed[url];
    }
  }
  await browser.storage.local.set({ blockedUrls: blocked, processedUrls: processed });
  await refreshBlockedCounts();
}

// ============================================================================
// View management
// ============================================================================

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.classList.toggle("hidden", key !== name);
  }
}

// ============================================================================
// Init
// ============================================================================

async function init() {
  // Load token
  const token = await getToken();
  if (token) {
    els.tokenInput.value = "••••••••••••••••";
    els.tokenMissing.classList.add("hidden");
  } else {
    els.tokenMissing.classList.remove("hidden");
  }

  // Load polling state
  const { pollingEnabled } = await browser.storage.local.get("pollingEnabled");
  els.pollingToggle.checked = pollingEnabled !== false;

  // Load enrichment threshold + permanently skipped counter
  const { lowWordCount } = await browser.storage.local.get("lowWordCount");
  els.lowWordInput.value = clampLowWordCount(lowWordCount);
  await refreshBlockedCounts();

  // On Android, show the tab extraction toggle
  try {
    const platformInfo = await browser.runtime.getPlatformInfo();
    if (platformInfo.os === "android") {
      els.tabExtractionRow.classList.remove("hidden");
      const { tabExtractionEnabled } =
        await browser.storage.local.get("tabExtractionEnabled");
      els.tabExtractionToggle.checked = tabExtractionEnabled === true;
    }
  } catch {
    // getPlatformInfo not available, leave toggle hidden (desktop)
  }

  // Get background status
  try {
    const status = await browser.runtime.sendMessage({ type: "GET_STATUS" });
    updatePollerStatus(status);
  } catch {
    els.pollerStatus.textContent = "Background script not running";
  }

  // Get current tab
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs[0];

  if (
    !currentTab?.url ||
    currentTab.url.startsWith("about:") ||
    currentTab.url.startsWith("moz-extension:") ||
    currentTab.url.startsWith("chrome:") ||
    currentTab.url.includes("readwise.io")
  ) {
    showView("noPage");
    return;
  }

  // Show page info
  els.pageTitle.textContent = currentTab.title || "Untitled";
  els.pageUrl.textContent = new URL(currentTab.url).hostname;
  showView("save");
}

function updatePollerStatus(status) {
  if (!status.hasToken) {
    els.pollerStatus.textContent = "Set your Readwise token to enable.";
    return;
  }
  if (status.pollerActive) {
    // processedCount is the number of URLs handled in the last 24 hours
    // (the cooldown window), not the number enriched during this session.
    const n = status.processedCount;
    els.pollerStatus.textContent = `Active — ${n} article${n === 1 ? "" : "s"} processed in the last 24 hours.`;
  } else {
    els.pollerStatus.textContent = "Paused.";
  }
}

// ============================================================================
// Save current page
// ============================================================================

async function savePage() {
  if (!currentTab?.url) return;

  const token = await getToken();
  if (!token) {
    els.tokenMissing.classList.remove("hidden");
    return;
  }

  showView("saving");

  try {
    // Extract the full page HTML from the current tab
    const results = await browser.tabs.executeScript(currentTab.id, {
      code: `document.documentElement.outerHTML`,
    });

    const html = results?.[0];
    if (!html) throw new Error("Could not extract page content");

    // Clean the URL
    const articleUrl = stripTracking(currentTab.url);

    // Send to background for API call
    const result = await browser.runtime.sendMessage({
      type: "SAVE_PAGE",
      url: articleUrl,
      html,
      title: currentTab.title,
    });

    if (result.success) {
      showView("saved");
      if (result.url) {
        els.readerLink.href = result.url;
      }
    } else {
      throw new Error(result.error || "Unknown error");
    }
  } catch (err) {
    showView("error");
    els.errorMessage.textContent = `Error: ${err.message}`;
  }
}

/**
 * Clean tracking parameters from URLs.
 */
function stripTracking(url) {
  try {
    const parsed = new URL(url);
    // Remove common tracking params
    const trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "utm_id",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
      "ref",
    ];
    for (const param of trackingParams) {
      parsed.searchParams.delete(param);
    }
    // If no params left, clear the search string entirely
    if ([...parsed.searchParams].length === 0) {
      parsed.search = "";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

// ============================================================================
// Token management
// ============================================================================

async function saveTokenAction() {
  const token = els.tokenInput.value.trim();
  if (!token || token === "••••••••••••••••") return;

  const valid = await validateToken(token);
  if (!valid) {
    alert("Invalid token. Please check and try again.");
    return;
  }

  await browser.storage.local.set({ readwiseToken: token });
  els.tokenInput.value = "••••••••••••••••";
  els.tokenInput.type = "password";
  els.tokenMissing.classList.add("hidden");

  // Start poller now that we have a token
  const { pollingEnabled } = await browser.storage.local.get("pollingEnabled");
  if (pollingEnabled !== false) {
    browser.runtime.sendMessage({ type: "SET_POLLING", enabled: true });
  }
}

// ============================================================================
// Events
// ============================================================================

els.saveBtn.addEventListener("click", savePage);
els.retryBtn.addEventListener("click", savePage);
els.saveTokenBtn.addEventListener("click", saveTokenAction);

els.retryAllBtn.addEventListener("click", async () => {
  els.retryAllBtn.disabled = true;
  els.retryAllBtn.textContent = "Re-checking…";
  await browser.runtime.sendMessage({ type: "CLEAR_CACHE_AND_POLL" });
  // Update status after a moment
  setTimeout(async () => {
    const status = await browser.runtime.sendMessage({ type: "GET_STATUS" });
    updatePollerStatus(status);
    els.retryAllBtn.disabled = false;
    els.retryAllBtn.textContent = "Re-check all recent articles";
  }, 3000);
});

els.lowWordInput.addEventListener("change", async () => {
  const value = clampLowWordCount(els.lowWordInput.value);
  els.lowWordInput.value = value;
  await browser.storage.local.set({ lowWordCount: value });
});

els.retryPaywallsBtn.addEventListener("click", async () => {
  await forgetBlocked("paywall");
});

els.resetCompleteBtn.addEventListener("click", async () => {
  await forgetBlocked("complete");
});

els.manageListBtn.addEventListener("click", () => {
  // Dedicated tab rather than the cramped embed inside about:addons.
  browser.tabs.create({ url: browser.runtime.getURL("options.html") });
});

els.tabExtractionToggle.addEventListener("change", async () => {
  await browser.storage.local.set({
    tabExtractionEnabled: els.tabExtractionToggle.checked,
  });
});

els.pollingToggle.addEventListener("change", async () => {
  const enabled = els.pollingToggle.checked;
  const result = await browser.runtime.sendMessage({
    type: "SET_POLLING",
    enabled,
  });
  if (result.success) {
    const status = await browser.runtime.sendMessage({ type: "GET_STATUS" });
    updatePollerStatus(status);
  }
});

els.tokenInput.addEventListener("focus", () => {
  if (els.tokenInput.value === "••••••••••••••••") {
    els.tokenInput.value = "";
    els.tokenInput.type = "text";
  }
});

els.tokenInput.addEventListener("blur", async () => {
  const token = await getToken();
  if (token && !els.tokenInput.value.trim()) {
    els.tokenInput.value = "••••••••••••••••";
    els.tokenInput.type = "password";
  }
});

// ============================================================================
// Start
// ============================================================================

init();
