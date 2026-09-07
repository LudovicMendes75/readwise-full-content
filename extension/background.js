/**
 * Background script — polls Readwise for thin/paywalled documents and
 * enriches them with full page content by loading them in background tabs.
 */

// ============================================================================
// Constants
// ============================================================================

/** Poll interval in minutes */
const POLL_INTERVAL_MINUTES = 2;

/**
 * Documents with fewer words than this are always candidates for enrichment.
 * This catches obvious stubs that have very little content.
 */
const LOW_WORD_COUNT = 200;

/**
 * Documents above this word count are never enriched (assumed complete).
 * Between LOW and HIGH, we check for paywall markers in the HTML.
 */
const HIGH_WORD_COUNT = 1500;

/**
 * Paywall / registration wall markers found in stub HTML.
 * If any of these appear in a document's HTML content, it's considered
 * paywalled regardless of word count (within the LOW–HIGH range).
 * Case-insensitive matching.
 */
const PAYWALL_MARKERS = [
  // Generic paywall CTAs
  "subscribe now",
  "start your free trial",
  "free trial",
  "create a free account",
  "create account",
  "register now",
  "sign up to read",
  "log in to read",
  "already have an account",
  "already a subscriber",
  "continue reading with",
  "unlock this article",
  "get unlimited access",
  "become a member",
  "subscribers only",
  "subscriber exclusive",
  "premium content",

  // Economist-specific
  "regwall:register",
  "regwall:login",
  "regwall:subscribe",
  "subscribe:article-regwall",

  // Washington Post
  "subscribe to continue reading",
  "free account to read this",

  // Wired / Condé Nast
  "already a wired subscriber",

  // NYT
  "subscriber-only content",
  "create your free account or log in",

  // FT
  "choose your subscription",
  "ft.com/products",

  // Le Monde (FR) — stub truncation notice: "Il vous reste 62% de cet
  // article à lire. La suite est réservée aux abonnés." This wording only
  // appears on truncated (paywalled) articles, not on fully served ones
  // (verified empirically — generic "Réservé aux abonnés" banners appear on
  // all Le Monde pages and must NOT be used as a marker).
  "de cet article à lire",

  // Télérama / Que Choisir (FR) — "Réservé aux abonnés" (masculine
  // singular) appears in truncated stubs before the publication date and at
  // the end of free content. Verified empirically: absent from fully served
  // Télérama articles (whose generic menus say "réservée à nos inscrits" /
  // "Avantages abonnés" — no match) and matches "Article réservé aux
  // abonnés" on quechoisir.org.
  "réservé aux abonnés",

  // Generic data-attribute markers
  "data-paywall",
  "data-regwall",
  "class=\"paywall",
  "class=\"regwall",
  'id="paywall',
  'id="regwall',
];

/**
 * Max pages to fetch from the Readwise API per poll.
 * Each page holds up to 100 documents, so 5 pages = 500 docs max.
 * This is a safety cap to prevent runaway loops.
 */
const MAX_LIST_PAGES = 5;

/** How long to wait for a page to load before extracting (ms) */
const PAGE_LOAD_TIMEOUT = 15000;

/** Cooldown: don't re-process the same URL within this window (ms) */
const PROCESS_COOLDOWN = 24 * 60 * 60 * 1000; // 24 hours

/** How far back to look for documents to enrich (ms) */
const LOOKBACK_WINDOW = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Minimum HTML size (bytes) to consider an extraction successful.
 * Cloudflare challenge pages are typically small (~5-15KB).
 * Real article pages are usually 50KB+.
 */
const MIN_HTML_SIZE = 30000;

// ============================================================================
// Platform detection
// ============================================================================

/**
 * Whether we're running on Android Firefox.
 * On Android, background tabs are not truly hidden — they become visible
 * foreground tabs and trigger Firefox's "open in app?" prompts.
 * Set once at init via getPlatformInfo().
 */
let isAndroid = false;

/**
 * Guard against concurrent pollAndEnrich() runs.
 * Multiple triggers can overlap: alarm fires, "Re-check" button, toggling
 * polling on — all call pollAndEnrich() without awaiting the previous run.
 * Two concurrent runs processing the same article both call replaceDocument(),
 * racing the delete→create cycle, which creates exact duplicates.
 */
let isPolling = false;

// ============================================================================
// State — persisted to storage to survive event page unloads
// ============================================================================

/**
 * Get the set of recently processed URLs from storage.
 * @returns {Promise<Record<string, number>>} Map of URL → timestamp
 */
async function getProcessedUrls() {
  const { processedUrls } = await browser.storage.local.get("processedUrls");
  return processedUrls || {};
}

async function markProcessed(url) {
  const urls = await getProcessedUrls();
  urls[url] = Date.now();

  // Prune entries older than cooldown
  const cutoff = Date.now() - PROCESS_COOLDOWN;
  for (const [key, ts] of Object.entries(urls)) {
    if (ts < cutoff) delete urls[key];
  }

  await browser.storage.local.set({ processedUrls: urls });
}

async function isRecentlyProcessed(url) {
  const urls = await getProcessedUrls();
  const ts = urls[url];
  if (!ts) return false;
  return Date.now() - ts < PROCESS_COOLDOWN;
}

async function getEnrichCount() {
  const urls = await getProcessedUrls();
  return Object.keys(urls).length;
}

// ============================================================================
// Polling logic
// ============================================================================

/**
 * Check recent Readwise documents and enrich any that look thin.
 */
async function pollAndEnrich() {
  // Prevent concurrent poll runs — alarm fires, "Re-check" button,
  // and polling toggle can all trigger this simultaneously
  if (isPolling) {
    console.log("[readwise-full-content] Poll already in progress, skipping");
    return;
  }
  isPolling = true;

  try {
    const token = await getToken();
    if (!token) return;

    const { pollingEnabled } = await browser.storage.local.get("pollingEnabled");
    if (pollingEnabled === false) return;

    console.log("[readwise-full-content] Polling for thin documents...");

    // Fetch documents updated recently, including HTML content
    // so we can check for paywall markers
    const lookbackDate = new Date(Date.now() - LOOKBACK_WINDOW).toISOString();
    const docs = await listDocuments(token, {
      updatedAfter: lookbackDate,
      maxPages: MAX_LIST_PAGES,
      withHtmlContent: true,
    });

    console.log(
      `[readwise-full-content] Found ${docs.length} recent documents`,
    );

    let enriched = 0;
    let skipped = 0;

    for (const doc of docs) {
      // Skip if already processed recently
      if (await isRecentlyProcessed(doc.source_url)) {
        skipped++;
        continue;
      }

      // Skip documents already enriched by this extension — re-enriching
      // won't help (same paywall will block again) and prevents cross-browser
      // duplication when multiple Firefox instances run the extension
      if (doc.source === "readwise-full-content") continue;

      // Only enrich documents the user has saved (inbox, later, shortlist).
      // Skip feed items (not yet triaged) and archived documents.
      const enrichLocations = ["new", "later", "shortlist"];
      if (!enrichLocations.includes(doc.location)) continue;

      // Skip if clearly complete (high word count, no markers needed)
      if (doc.word_count >= HIGH_WORD_COUNT) continue;

      // Skip non-web content (PDFs, tweets, etc.)
      const validCategories = ["article", "rss"];
      if (!validCategories.includes(doc.category)) continue;

      // Skip if no source URL
      if (!doc.source_url) continue;

      // Skip internal URLs
      try {
        const url = new URL(doc.source_url);
        if (url.hostname.includes("readwise.io")) continue;
        if (url.hostname.includes("read.readwise.io")) continue;
        if (!url.protocol.startsWith("http")) continue;
      } catch {
        continue;
      }

      // Determine if this document needs enrichment
      const needsEnrichment = shouldEnrich(doc);
      if (!needsEnrichment) continue;

      console.log(
        `[readwise-full-content] Enriching: "${doc.title}" (${doc.word_count} words, reason: ${needsEnrichment}) — ${doc.source_url}`,
      );

      try {
        const result = await enrichDocument(token, doc);
        // Mark the original source URL as processed
        await markProcessed(doc.source_url);
        // Also mark the canonical URL if the fetch followed redirects
        // (e.g. UTM params stripped, email click trackers resolved).
        // Without this, the replacement doc's new URL won't be protected
        // by the cooldown, causing a re-enrichment loop.
        if (result.canonicalUrl && result.canonicalUrl !== doc.source_url) {
          await markProcessed(result.canonicalUrl);
        }
        if (result.enriched) enriched++;
      } catch (err) {
        if (err.message?.startsWith("RATE_LIMITED")) {
          console.warn("[readwise-full-content] Rate limited, will retry next poll");
          return;
        }
        console.error(
          `[readwise-full-content] Failed to enrich "${doc.title}":`,
          err.message,
        );
        // Don't markProcessed on errors — allow retry on the next poll cycle.
        // Only successful enrichments (or intentional skips returned as false
        // from enrichDocument) get the 24-hour cooldown.
      }
    }

    console.log(
      `[readwise-full-content] Poll complete: ${enriched} enriched, ${skipped} already processed`,
    );
  } catch (err) {
    if (err.message?.startsWith("RATE_LIMITED")) {
      console.warn("[readwise-full-content] Rate limited during list, will retry next poll");
      return;
    }
    console.error("[readwise-full-content] Poll error:", err);
  } finally {
    isPolling = false;
  }
}

/**
 * Determine if a document needs enrichment.
 * Returns a reason string if yes, or false if no.
 *
 * Logic:
 * - Very low word count (< LOW_WORD_COUNT): always enrich
 * - Low-to-medium word count (LOW–HIGH): check HTML for paywall markers
 * - High word count (>= HIGH_WORD_COUNT): skip (assumed complete)
 */
function shouldEnrich(doc) {
  if (doc.word_count < LOW_WORD_COUNT) {
    return "low-word-count";
  }

  // For medium word count, check the HTML content for paywall markers
  const html = doc.html_content || "";
  if (html && hasPaywallMarkers(html)) {
    return "paywall-detected";
  }

  // If no HTML content available from Readwise, be conservative
  // and enrich anything under the high threshold from known paywall sites
  if (!html && doc.word_count < HIGH_WORD_COUNT) {
    return "no-html-available";
  }

  return false;
}

/**
 * Check if HTML content contains paywall / registration markers.
 */
function hasPaywallMarkers(html) {
  const lower = html.toLowerCase();
  return PAYWALL_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

/**
 * Enrich a single document by loading it in a background tab,
 * extracting the full page HTML, and pushing it to Readwise.
 *
 * @returns {{ enriched: boolean, canonicalUrl?: string }}
 *   enriched: true if the document was replaced with full content
 *   canonicalUrl: the URL used for the replacement (after redirects),
 *     so the caller can mark it as processed to prevent re-enrichment
 */
async function enrichDocument(token, doc) {
  const result = await extractPageHtml(doc.source_url);

  if (!result?.html) {
    console.warn(
      `[readwise-full-content] No HTML extracted from ${doc.source_url}`,
    );
    return { enriched: false };
  }

  const { html, finalUrl } = result;

  // The fetch→tab fallback already filters challenge pages,
  // but double-check in case the tab fallback also got a challenge
  if (!isUsableHtml(html)) {
    console.warn(
      `[readwise-full-content] Unusable HTML (${html.length} bytes), skipping — ${doc.source_url}`,
    );
    return { enriched: false };
  }

  // Use the final URL (after redirects) as the canonical URL.
  // This handles tracking redirects like click.e.economist.com → economist.com
  const canonicalUrl = finalUrl || doc.source_url;

  // Check if the extracted HTML still contains paywall markers.
  // This means the fetch didn't get past the paywall — replacing the
  // document would just swap one paywall stub for another, and the
  // resulting low word count would trigger re-enrichment on the next poll.
  if (hasPaywallMarkers(html)) {
    console.warn(
      `[readwise-full-content] Extracted HTML contains paywall markers, skipping — ${doc.source_url}`,
    );
    return { enriched: false, canonicalUrl };
  }

  // Preserve tags: the replacement document is created fresh and would
  // otherwise lose the user's categorization (tags set manually or by an
  // external triage pipeline). The Readwise save API accepts a "tags" field.
  const tagNames = (doc.tags || [])
    .map((t) => (typeof t === "string" ? t : t && t.name))
    .filter(Boolean);

  // Replace the thin document with the full-content version
  await replaceDocument(token, doc.id, {
    url: canonicalUrl,
    html,
    should_clean_html: true,
    title: doc.title,
    author: doc.author,
    summary: doc.summary,
    published_date: doc.published_date,
    image_url: doc.image_url,
    tags: tagNames,
    location: doc.location,
    category: "article",
    saved_using: "readwise-full-content",
  });

  console.log(
    `[readwise-full-content] ✓ Enriched: "${doc.title}"` +
      (canonicalUrl !== doc.source_url
        ? ` (redirected to ${canonicalUrl})`
        : ""),
  );
  return { enriched: true, canonicalUrl };
}

/**
 * Extract full page HTML from a URL.
 *
 * Strategy: try fetch() first (invisible, fast, carries cookies).
 * If the response looks like a Cloudflare challenge or is too small,
 * fall back to opening a real background tab (visible but handles JS).
 *
 * Returns { html, finalUrl } where finalUrl is the URL after redirects.
 */
async function extractPageHtml(url) {
  // First try: invisible fetch with cookies
  const fetchResult = await extractViaFetch(url);
  if (fetchResult && isUsableHtml(fetchResult.html)) {
    console.log(
      `[readwise-full-content] Fetched via invisible request: ${url}`,
    );
    return fetchResult;
  }

  // On Android, tabs are not truly backgrounded — they become visible,
  // cause jarring tab flashing, and trigger Firefox "open in app?" prompts.
  // Skip the tab fallback unless the user explicitly opted in via the popup.
  if (isAndroid) {
    const { tabExtractionEnabled } = await browser.storage.local.get("tabExtractionEnabled");
    if (!tabExtractionEnabled) {
      console.log(
        `[readwise-full-content] Fetch insufficient, skipping tab fallback (Android): ${url}`,
      );
      return null;
    }
    console.log(
      `[readwise-full-content] Tab extraction enabled on Android, using tab fallback: ${url}`,
    );
  }

  // Fallback: open a real browser tab (handles JS challenges)
  console.log(
    `[readwise-full-content] Fetch insufficient, falling back to tab: ${url}`,
  );
  return extractViaTab(url);
}

/**
 * Try to fetch page HTML using fetch() with credentials.
 * This is invisible — no tab flashing.
 * Works for most sites since the extension has host permissions
 * and fetch() includes cookies.
 */
async function extractViaFetch(url) {
  try {
    const res = await fetch(url, {
      credentials: "include",
      redirect: "follow",
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": navigator.userAgent,
      },
    });

    if (!res.ok) return null;

    const html = await res.text();
    const finalUrl = res.url; // URL after redirects
    return { html, finalUrl };
  } catch (err) {
    console.warn(
      `[readwise-full-content] Fetch failed for ${url}:`,
      err.message,
    );
    return null;
  }
}

/**
 * Check if HTML looks like real page content (not a challenge page).
 */
function isUsableHtml(html) {
  if (!html || html.length < MIN_HTML_SIZE) return false;

  // Cloudflare challenge markers
  if (
    html.includes("cf-challenge-running") ||
    html.includes("challenge-platform") ||
    html.includes("Just a moment...") ||
    html.includes("Checking your browser")
  ) {
    return false;
  }

  return true;
}

/**
 * Fallback: load URL in a real background tab for JS-heavy sites.
 * The tab is visible briefly in the tab bar.
 */
async function extractViaTab(url) {
  let tab;
  try {
    tab = await browser.tabs.create({ url, active: false });

    await waitForTabLoad(tab.id);

    // Give JS-rendered content a moment to hydrate
    await new Promise((r) => setTimeout(r, 3000));

    // Get the final URL (after redirects) and extract HTML
    const updatedTab = await browser.tabs.get(tab.id);
    const finalUrl = updatedTab.url;

    const results = await browser.tabs.executeScript(tab.id, {
      code: `document.documentElement.outerHTML`,
    });

    const html = results?.[0] || null;
    return html ? { html, finalUrl } : null;
  } catch (err) {
    console.error(
      `[readwise-full-content] Tab extraction error for ${url}:`,
      err.message,
    );
    return null;
  } finally {
    if (tab?.id) {
      try {
        await browser.tabs.remove(tab.id);
      } catch {
        // Tab may already be closed
      }
    }
  }
}

/**
 * Wait for a tab to reach "complete" loading state, with timeout.
 */
function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    }, PAGE_LOAD_TIMEOUT);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        browser.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    browser.tabs.onUpdated.addListener(listener);

    browser.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") {
          clearTimeout(timeout);
          browser.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      })
      .catch(reject);
  });
}

// ============================================================================
// Alarm-based polling
// ============================================================================

// Handle alarm fires
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "readwise-poll") {
    pollAndEnrich().catch((err) =>
      console.error("[readwise-full-content] Poll error:", err),
    );
  }
});

async function ensurePollerRunning() {
  const token = await getToken();
  if (!token) return;

  const { pollingEnabled } = await browser.storage.local.get("pollingEnabled");
  if (pollingEnabled === false) return;

  // alarms.get returns the alarm if it exists, or undefined
  const existing = await browser.alarms.get("readwise-poll");
  if (!existing) {
    await browser.alarms.create("readwise-poll", {
      periodInMinutes: POLL_INTERVAL_MINUTES,
    });
    console.log("[readwise-full-content] Poller alarm created");
  }
}

async function stopPoller() {
  await browser.alarms.clear("readwise-poll");
  console.log("[readwise-full-content] Poller alarm cleared");
}

// ============================================================================
// Message handler (from popup)
// ============================================================================

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Save current page to Readwise (mobile/manual flow)
  if (message.type === "SAVE_PAGE") {
    (async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error("Readwise token not configured");

        const result = await createDocument(token, {
          url: message.url,
          html: message.html,
          should_clean_html: true,
          title: message.title,
          author: message.author,
          location: "new",
          category: "article",
          saved_using: "readwise-full-content",
        });

        if (result.alreadyExisted) {
          const replaced = await replaceDocument(token, result.id, {
            url: message.url,
            html: message.html,
            should_clean_html: true,
            title: message.title,
            author: message.author,
            location: "new",
            category: "article",
            saved_using: "readwise-full-content",
          });
          sendResponse({ success: true, ...replaced });
        } else {
          sendResponse({ success: true, ...result });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Get poller status
  if (message.type === "GET_STATUS") {
    (async () => {
      const token = await getToken();
      const { pollingEnabled } = await browser.storage.local.get(
        "pollingEnabled",
      );
      const alarm = await browser.alarms.get("readwise-poll");
      const enrichCount = await getEnrichCount();
      sendResponse({
        hasToken: !!token,
        pollerActive: pollingEnabled !== false && !!alarm,
        processedCount: enrichCount,
      });
    })();
    return true;
  }

  // Clear processed cache and re-poll immediately
  if (message.type === "CLEAR_CACHE_AND_POLL") {
    (async () => {
      await browser.storage.local.remove("processedUrls");
      console.log("[readwise-full-content] Cleared processed URLs cache");
      await ensurePollerRunning();
      pollAndEnrich();
      sendResponse({ success: true });
    })();
    return true;
  }

  // Toggle polling
  if (message.type === "SET_POLLING") {
    (async () => {
      await browser.storage.local.set({ pollingEnabled: message.enabled });
      if (message.enabled) {
        await ensurePollerRunning();
        // Also run immediately
        pollAndEnrich();
      } else {
        await stopPoller();
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  return false;
});

// ============================================================================
// Init — runs every time the event page wakes up
// ============================================================================

(async () => {
  // Detect platform once at startup
  try {
    const platformInfo = await browser.runtime.getPlatformInfo();
    isAndroid = platformInfo.os === "android";
    if (isAndroid) {
      console.log("[readwise-full-content] Running on Android — tab fallback disabled");
    }
  } catch {
    // getPlatformInfo not available, assume desktop
  }

  const token = await getToken();
  if (!token) return;

  const { pollingEnabled } = await browser.storage.local.get("pollingEnabled");
  if (pollingEnabled !== false) {
    await browser.storage.local.set({ pollingEnabled: true });
    await ensurePollerRunning();
  }
})();
