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
 * Default number of words below which a document is always enriched.
 * This catches obvious stubs that have very little content.
 * Raised from 200 to 500 (wp48/b07a): paywalled articles whose RSS teaser is
 * 200-400 words were never enriched automatically and waited for a manual
 * "Save Full Page".
 * Overridable at runtime from the popup (storage key "lowWordCount") so a
 * future adjustment does not require re-signing the extension.
 */
const DEFAULT_LOW_WORD_COUNT = 500;

/** Bounds accepted for the popup setting (words). */
const MIN_LOW_WORD_COUNT = 100;
const MAX_LOW_WORD_COUNT = 1500;

/**
 * Retry schedule for a paywall that resisted extraction: the first attempt is
 * immediate, then 1 day, 7 days and 30 days. After the 4th attempt the URL is
 * left alone until a manual retry from the options page.
 */
const PAYWALL_BACKOFF_MS = [
  24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
];

/**
 * Documents above this word count are never enriched (assumed complete).
 * Between LOW and HIGH, we check for paywall markers in the HTML.
 */
const HIGH_WORD_COUNT = 1500;

/**
 * Minimum gain for a re-save to be worth it: the extracted page must contain
 * at least this ratio of the word count Readwise already reports. Below that,
 * the re-save adds no content but still bumps updated_at (wp48/b07a).
 */
const MIN_GAIN_RATIO = 1.2;

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

/**
 * Record of articles the extension could not enrich, with the reason. The
 * article length never decides anything: only the extraction outcome does.
 *  - "paywall": the page is still gated after extraction. Retried after 1 day,
 *    7 days and 30 days, then left alone until a manual retry.
 *  - "complete": no paywall signal and no extra content, so the article was
 *    already complete. Never retried.
 * Shape: { [url]: { reason, attempts, lastAttemptAt, nextAttemptAt, title } }
 * nextAttemptAt === null means terminal (no automatic retry).
 * Everything is visible and reversible from the options page.
 */
async function getBlockedUrls() {
  const { blockedUrls } = await browser.storage.local.get("blockedUrls");
  return blockedUrls || {};
}

async function getBlockedEntry(url) {
  const blocked = await getBlockedUrls();
  return blocked[url] || null;
}

async function recordBlocked(url, reason, title, aliasOf) {
  const blocked = await getBlockedUrls();
  const previous = blocked[url] || { attempts: 0 };
  const attempts = previous.attempts + 1;
  let nextAttemptAt = null;
  if (reason === "paywall" && attempts <= PAYWALL_BACKOFF_MS.length) {
    nextAttemptAt = Date.now() + PAYWALL_BACKOFF_MS[attempts - 1];
  }
  blocked[url] = {
    reason,
    attempts,
    lastAttemptAt: Date.now(),
    nextAttemptAt,
    title: title || previous.title || "",
    // Canonical URL of an article already recorded under its source URL:
    // kept so the poll can skip it, hidden in the UI to avoid duplicates.
    aliasOf: aliasOf || null,
  };
  await browser.storage.local.set({ blockedUrls: blocked });
}

/**
 * One-time cleanup for records written before canonical aliases existed: two
 * entries sharing the same title and host are the same article, so the extra
 * one becomes a hidden alias. Idempotent (guarded by a storage flag).
 */
async function migrateBlockedAliases() {
  const { blockedMigrated } = await browser.storage.local.get("blockedMigrated");
  if (blockedMigrated) return;
  const blocked = await getBlockedUrls();
  const seen = new Map();
  let changed = false;
  for (const [url, entry] of Object.entries(blocked)) {
    if (entry.aliasOf) continue;
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      // keep the raw URL as key
    }
    const key = `${entry.title || ""}|${host}`;
    if (seen.has(key)) {
      entry.aliasOf = seen.get(key);
      changed = true;
    } else {
      seen.set(key, url);
    }
  }
  if (changed) await browser.storage.local.set({ blockedUrls: blocked });
  await browser.storage.local.set({ blockedMigrated: true });
}

async function clearBlocked(url) {
  const blocked = await getBlockedUrls();
  if (blocked[url]) {
    delete blocked[url];
    await browser.storage.local.set({ blockedUrls: blocked });
  }
}

/**
 * Effective "thin article" threshold: the popup setting when valid, the
 * compiled-in default otherwise. Clamped so a bad value cannot disable the
 * guard or make every document a candidate.
 */
async function getLowWordCount() {
  const { lowWordCount } = await browser.storage.local.get("lowWordCount");
  // Number(null) and Number("") are 0, not NaN: check emptiness explicitly so
  // an unset value falls back to the default instead of the lower bound.
  if (lowWordCount === undefined || lowWordCount === null || lowWordCount === "") {
    return DEFAULT_LOW_WORD_COUNT;
  }
  const n = Math.round(Number(lowWordCount));
  if (!Number.isFinite(n)) return DEFAULT_LOW_WORD_COUNT;
  return Math.min(Math.max(n, MIN_LOW_WORD_COUNT), MAX_LOW_WORD_COUNT);
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

    // Fetch the whole 'later' queue (the enrichment pipeline population),
    // including HTML content so we can check for paywall markers.
    // An updatedAfter lookback misses older stubs entirely: updated_at does
    // NOT change on bulk tag/location updates (observed 2026-09-08 — stubs
    // tagged by an external triage pipeline kept their original timestamp,
    // leaving the 24h window with only brand-new saves). location=later
    // covers the whole queue; the 24h per-URL cooldown prevents
    // re-processing.
    const lowWordCount = await getLowWordCount();
    const docs = await listDocuments(token, {
      location: "later",
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

      // Respect the recorded outcome: a paywall waiting for its next attempt,
      // and an article known to be complete, are both skipped until due.
      const blocked = await getBlockedEntry(doc.source_url);
      if (blocked) {
        const due =
          Boolean(blocked.nextAttemptAt) &&
          blocked.nextAttemptAt <= Date.now();
        if (!due) {
          skipped++;
          continue;
        }
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
      const needsEnrichment = shouldEnrich(doc, lowWordCount);
      if (!needsEnrichment) continue;

      console.log(
        `[readwise-full-content] Enriching: "${doc.title}" (${doc.word_count} words, reason: ${needsEnrichment}) — ${doc.source_url}`,
      );

      try {
        const result = await enrichDocument(token, doc, lowWordCount);
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
 * - Very low word count (< lowWordCount): always enrich
 * - Low-to-medium word count (LOW–HIGH): check HTML for paywall markers
 * - High word count (>= HIGH_WORD_COUNT): skip (assumed complete)
 */
function shouldEnrich(doc, lowWordCount = DEFAULT_LOW_WORD_COUNT) {
  if (doc.word_count < lowWordCount) {
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
 * Phrases printed only where an article is cut for non-subscribers. Generic
 * banners such as "réservé aux abonnés" are excluded on purpose: they also
 * appear on fully served pages (calibrated on 50 documents, wp48/b03 — D15).
 */
const TRUNCATION_MARKERS = [
  "de cet article à lire",
  "pour lire la suite",
  "abonnez-vous pour lire",
  "cet article est réservé",
  "la suite est réservée",
];

/**
 * Structural paywall containers. Some sites ship them hidden for subscribers,
 * so a hit is a hint, not a proof: the decision to retry rests on the absence
 * of extra content, this only names the reason.
 */
const PAYWALL_CONTAINER_RE =
  /(?:class|id)\s*=\s*["'][^"']*(?:paywall|regwall|subscriber-only|premium-content|content-gate|article-gate)[^"']*["']/i;

/**
 * Detect whether an extracted page is still gated.
 * Deliberately biased towards "paywall": a false positive costs three spaced
 * retries, a false negative makes the article silently give up.
 * @returns {{ paywall: boolean, signals: string[] }}
 */
function detectPaywall(html) {
  const signals = [];
  const lower = html.toLowerCase();

  if (/"isaccessibleforfree"\s*:\s*false/i.test(html)) {
    signals.push("json-ld");
  }
  if (/article:content_tier[^>]*content=["'](locked|premium)["']/i.test(html)) {
    signals.push("content_tier");
  }
  if (PAYWALL_CONTAINER_RE.test(html)) {
    signals.push("container");
  }
  const truncation = TRUNCATION_MARKERS.find((m) => lower.includes(m));
  if (truncation) {
    signals.push("truncation");
  }

  return { paywall: signals.length > 0, signals };
}

/**
 * Rough word count of an HTML fragment (scripts, styles and tags stripped).
 * Used by the anti-loop guard to compare the extracted page with the word
 * count Readwise already reports. Deliberately approximate.
 */
function estimateWordCount(html) {
  if (!html) return 0;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.split(" ").length : 0;
}

/**
 * Word count restricted to <p> elements, falling back to the whole HTML when
 * a page has too little paragraph markup. Article bodies live in <p>;
 * navigation and footers do not, so this resists noise far better than a raw
 * tag-stripped count.
 */
function estimateArticleWordCount(html) {
  if (!html) return 0;
  const paragraphs = html.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [];
  const paragraphWords = estimateWordCount(paragraphs.join(" "));
  return paragraphWords >= 80 ? paragraphWords : estimateWordCount(html);
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
async function enrichDocument(token, doc, lowWordCount = DEFAULT_LOW_WORD_COUNT) {
  const result = await extractPageHtml(doc.source_url);

  if (!result?.html) {
    console.warn(
      `[readwise-full-content] No HTML extracted from ${doc.source_url}`,
    );
    // Nothing extracted at all: usually a JS challenge or a blocked fetch.
    // Recorded as "paywall" (retriable) rather than "complete" (terminal):
    // the article may well be recoverable once the page serves normally.
    await recordBlocked(doc.source_url, "paywall", doc.title);
    return { enriched: false };
  }

  const { html, finalUrl } = result;

  // The fetch→tab fallback already filters challenge pages,
  // but double-check in case the tab fallback also got a challenge
  if (!isUsableHtml(html)) {
    console.warn(
      `[readwise-full-content] Unusable HTML (${html.length} bytes), skipping — ${doc.source_url}`,
    );
    // Challenge page or stub too small to be the article: same reasoning as
    // above, retriable rather than terminal.
    await recordBlocked(doc.source_url, "paywall", doc.title);
    return { enriched: false };
  }

  // Use the final URL (after redirects) as the canonical URL.
  // This handles tracking redirects like click.e.economist.com → economist.com
  const canonicalUrl = finalUrl || doc.source_url;

  // Decide from the extraction outcome, never from a word-count heuristic.
  // Two outcomes are failures, and only the reason differs:
  //  - still gated after extraction ("paywall") → retried with a backoff;
  //  - no extra content and no gate ("complete") → the article was already
  //    complete, retrying would never bring anything.
  const extractedWords = estimateArticleWordCount(html);
  const reportedWords = Number(doc.word_count) || 0;
  const gained = extractedWords >= reportedWords * MIN_GAIN_RATIO;

  if (!gained) {
    const verdict = detectPaywall(html);
    const reason = verdict.paywall ? "paywall" : "complete";
    console.warn(
      `[readwise-full-content] No gain (${extractedWords} extracted vs ${reportedWords} reported words) — ${reason}` +
        (verdict.signals.length ? ` [${verdict.signals.join(", ")}]` : "") +
        ` — ${doc.source_url}`,
    );
    await recordBlocked(doc.source_url, reason, doc.title);
    if (canonicalUrl !== doc.source_url) {
      await recordBlocked(canonicalUrl, reason, doc.title, doc.source_url);
    }
    return { enriched: false };
  }

  // Richer than what Readwise had: drop any stale record for these URLs.
  await clearBlocked(doc.source_url);
  if (canonicalUrl !== doc.source_url) {
    await clearBlocked(canonicalUrl);
  }

  // Preserve tags: the replacement document is created fresh and would
  // otherwise lose the user's categorization (tags set manually or by an
  // external triage pipeline). The Readwise save API accepts a "tags" field.
  // list/ returns tags as a {slug: {name, type, created}} MAP, not an array
  // (observed 2026-09-08) — extract names from both shapes.
  let tagNames = [];
  if (Array.isArray(doc.tags)) {
    tagNames = doc.tags.map((t) => (typeof t === "string" ? t : t && t.name));
  } else if (doc.tags && typeof doc.tags === "object") {
    tagNames = Object.keys(doc.tags);
  }
  const filteredTags = tagNames.filter(Boolean);
  console.log(
    `[readwise-full-content] Preserving ${filteredTags.length} tags: ${filteredTags.join(", ") || "(none)"}`,
  );

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
    tags: filteredTags,
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

  await migrateBlockedAliases();

  const { pollingEnabled } = await browser.storage.local.get("pollingEnabled");
  if (pollingEnabled !== false) {
    await browser.storage.local.set({ pollingEnabled: true });
    await ensurePollerRunning();
  }
})();
