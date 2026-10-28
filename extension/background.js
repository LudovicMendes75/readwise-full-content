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
 * A page must yield at least this many words of paragraph text to be worth
 * saving. Applies to documents Readwise reports as empty (word_count 0),
 * where the relative gain test is meaningless: without a floor, any page
 * with a menu would be saved as "full content".
 */
const MIN_SAVE_WORDS = 80;

/** A document is considered empty below this word count (archive backfill). */
const BACKFILL_EMPTY_WORDS = 20;

/** Maximum number of successful enrichments kept in the log. */
const ENRICHED_MAX = 500;

/**
 * Tags written back into Reader so an unrecoverable article is never silently
 * lost: one for a paywall that resisted every retry, one for content the
 * extension cannot process (PDF, tracker with no destination).
 */
const TAG_UNREACHABLE = "articles inaccessibles";
const TAG_MANUAL = "récupération manuelle";

/**
 * Delay between two archive backfill documents. Each one costs one DELETE and
 * one POST, and the documented delete limit is 20/min → 4s keeps a margin.
 */
const BACKFILL_DELAY_MS = 4000;

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

async function clearProcessed(urls) {
  if (urls.length === 0) return;
  const processed = await getProcessedUrls();
  for (const url of urls) delete processed[url];
  await browser.storage.local.set({ processedUrls: processed });
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

async function recordBlocked(url, reason, title, aliasOf, docId) {
  const blocked = await getBlockedUrls();
  const previous = blocked[url] || { attempts: 0 };
  const attempts = previous.attempts + 1;
  let nextAttemptAt = null;
  if (reason === "paywall" && attempts <= PAYWALL_BACKOFF_MS.length) {
    nextAttemptAt = Date.now() + PAYWALL_BACKOFF_MS[attempts - 1];
  }
  const entry = {
    reason,
    attempts,
    lastAttemptAt: Date.now(),
    nextAttemptAt,
    title: title || previous.title || "",
    // Canonical URL of an article already recorded under its source URL:
    // kept so the poll can skip it, hidden in the UI to avoid duplicates.
    aliasOf: aliasOf || null,
    // Kept so the options page can re-run this exact document on demand:
    // the list API has no filter by URL, only by id.
    id: docId || previous.id || null,
  };
  blocked[url] = entry;
  await browser.storage.local.set({ blockedUrls: blocked });
  return entry;
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

/**
 * Log of successful enrichments (newest first, capped). The blocked list alone
 * only shows failures, which biases any judgement on a backfill: without the
 * successes you cannot tell "nothing worked" from "everything worked".
 * Shape: [{ url, title, words, at }]
 */
async function getEnrichedUrls() {
  const { enrichedUrls } = await browser.storage.local.get("enrichedUrls");
  return Array.isArray(enrichedUrls) ? enrichedUrls : [];
}

async function recordEnriched(url, title, words) {
  const list = await getEnrichedUrls();
  const entry = { url, title: title || "", words: words || 0, at: Date.now() };
  const next = [entry, ...list.filter((item) => item.url !== url)].slice(
    0,
    ENRICHED_MAX,
  );
  await browser.storage.local.set({ enrichedUrls: next });
}

/**
 * Backfill the Readwise id on a blocked entry recorded by an older version,
 * so its row can be retried without a full archive scan.
 */
async function rememberBlockedId(url, id) {
  const blocked = await getBlockedUrls();
  if (blocked[url] && !blocked[url].id && id) {
    blocked[url].id = id;
    await browser.storage.local.set({ blockedUrls: blocked });
  }
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

    // A running backfill already holds the quota and the documents.
    const backfill = await getBackfillState();
    if (backfill.running) {
      console.log("[readwise-full-content] Backfill in progress, skipping poll");
      return;
    }

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
 * Minimal HTML entity decoding for titles (the save API rejects nothing here,
 * but a title with entities reads badly in Reader).
 */
function decodeEntities(text) {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

/**
 * Never send a blank title: the Readwise save API answers 400
 * {"title": ["This field may not be blank."]}, and replaceDocument has
 * already deleted the original at that point. Falls back to og:title,
 * <title>, <h1>, then the URL itself.
 */
function titleFromHtml(html, url) {
  const candidates = [];
  const og =
    html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  if (og) candidates.push(og[1]);
  const tag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (tag) candidates.push(tag[1]);
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) candidates.push(h1[1].replace(/<[^>]+>/g, " "));

  for (const raw of candidates) {
    const title = decodeEntities(raw).replace(/\s+/g, " ").trim().slice(0, 300);
    if (title) return title;
  }

  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    if (last) {
      const cleaned = decodeURIComponent(last)
        .replace(/[-_]+/g, " ")
        .replace(/\.[a-z0-9]+$/i, "")
        .trim();
      if (cleaned) return cleaned;
    }
    // Root URL: keep the hostname as-is (stripping the TLD would mangle it).
    return parsed.hostname;
  } catch {
    return url;
  }
}

/**
 * Does the extracted page bring something worth saving?
 * Two conditions: a real gain over what Readwise already has (20%), and a
 * floor of MIN_SAVE_WORDS so an empty document is never "enriched" with a
 * page that contains only navigation.
 */
function contentGained(extractedWords, reportedWordCount) {
  const reported = Number(reportedWordCount) || 0;
  return extractedWords >= Math.max(MIN_SAVE_WORDS, reported * MIN_GAIN_RATIO);
}

/**
 * Google Alerts and newsletter click trackers wrap the real article. Decode
 * them before fetching, otherwise the extraction lands on a redirect or
 * consent page and the article is wrongly declared unrecoverable.
 */
function resolveTargetUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === "google.com" || host.endsWith(".google.com") || host.endsWith(".google.fr")) {
      const target = parsed.searchParams.get("url") || parsed.searchParams.get("q");
      if (target && /^https?:/i.test(target)) return target;
    }
    // Trackers (Mailjet, Brevo, Sendinblue, Anses…) carry the destination as a
    // base64 run starting with "aHR0c" (= "http"), in a path segment or in a
    // query parameter depending on the provider.
    const base64Run = url.match(/aHR0c[A-Za-z0-9_-]+/);
    if (base64Run) {
      try {
        const raw = base64Run[0].replace(/-/g, "+").replace(/_/g, "/");
        const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        const decoded = new TextDecoder().decode(bytes);
        if (/^https?:/i.test(decoded)) return decoded;
      } catch {
        // not base64 after all: keep the original URL
      }
    }
    return url;
  } catch {
    return url;
  }
}

/** Tag names of a document, from either API shape (array or map). */
function tagNamesOf(doc) {
  if (Array.isArray(doc.tags)) {
    return doc.tags
      .map((tag) => (typeof tag === "string" ? tag : tag && tag.name))
      .filter(Boolean);
  }
  if (doc.tags && typeof doc.tags === "object") {
    return Object.keys(doc.tags);
  }
  return [];
}

/** Add a tag to the existing document (never removes the others). */
async function tagDocument(token, doc, tagName) {
  try {
    const existing = tagNamesOf(doc);
    if (existing.includes(tagName)) return;
    await updateDocumentTags(token, doc.id, [...existing, tagName]);
  } catch (err) {
    console.warn(
      `[readwise-full-content] Could not tag ${doc.id} "${tagName}": ${err.message}`,
    );
  }
}

/** Flag a document the extension cannot process, and stop retrying it. */
async function markManual(doc, token) {
  await tagDocument(token, doc, TAG_MANUAL);
  await recordBlocked(doc.source_url, "manual", doc.title, null, doc.id);
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
  const targetUrl = resolveTargetUrl(doc.source_url);

  // The extension cannot read a PDF (no tab access, no text layer): flag it
  // for manual handling instead of failing silently.
  if (/\.pdf(?:$|[?#])/i.test(targetUrl)) {
    await markManual(doc, token);
    return { enriched: false };
  }

  const result = await extractPageHtml(targetUrl);

  if (!result?.html) {
    console.warn(
      `[readwise-full-content] No HTML extracted from ${doc.source_url}`,
    );
    // Nothing extracted at all: usually a JS challenge or a blocked fetch.
    // Recorded as "paywall" (retriable) rather than "complete" (terminal):
    // the article may well be recoverable once the page serves normally.
    return failEnrichment(
      token,
      doc,
      targetUrl,
      null,
      "paywall",
      TAG_UNREACHABLE,
    );
  }

  const { html, finalUrl } = result;

  // The fetch→tab fallback already filters challenge pages,
  // but double-check in case the tab fallback also got a challenge
  if (!isUsableHtml(html)) {
    console.warn(
      `[readwise-full-content] Unusable HTML (${html.length} bytes), skipping — ${doc.source_url}`,
    );
    // Cloudflare challenge: no amount of automatic retrying will pass it, but
    // the article is readable in the browser. Flag it for the manual
    // "Save Full Page" flow instead of pretending it is a paywall.
    if (looksLikeChallenge(html)) {
      return failEnrichment(token, doc, targetUrl, null, "manual", TAG_MANUAL);
    }
    // Stub too small to be the article: retriable rather than terminal.
    return failEnrichment(
      token,
      doc,
      targetUrl,
      null,
      "paywall",
      TAG_UNREACHABLE,
    );
  }

  // Use the final URL (after redirects) as the canonical URL.
  // This handles tracking redirects like click.e.economist.com → economist.com
  const canonicalUrl = finalUrl || targetUrl;

  // Decide from the extraction outcome, never from a word-count heuristic.
  // Two outcomes are failures, and only the reason differs:
  //  - still gated after extraction ("paywall") → retried with a backoff;
  //  - no extra content and no gate ("complete") → the article was already
  //    complete, retrying would never bring anything.
  const extractedWords = estimateArticleWordCount(html);
  const reportedWords = Number(doc.word_count) || 0;
  const gained = contentGained(extractedWords, reportedWords);

  if (!gained) {
    const verdict = detectPaywall(html);
    const reason = verdict.paywall ? "paywall" : "complete";
    console.warn(
      `[readwise-full-content] No gain (${extractedWords} extracted vs ${reportedWords} reported words) — ${reason}` +
        (verdict.signals.length ? ` [${verdict.signals.join(", ")}]` : "") +
        ` — ${doc.source_url}`,
    );
    const failure = await failEnrichment(
      token,
      doc,
      targetUrl,
      canonicalUrl,
      reason,
      reason === "paywall" ? TAG_UNREACHABLE : null,
    );
    if (failure.rebuilt) return failure;
    // Alias entry for the canonical URL, so the poll skips it too.
    if (canonicalUrl !== doc.source_url) {
      await recordBlocked(canonicalUrl, reason, doc.title, doc.source_url, doc.id);
    }
    return failure;
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
  // A later success means the article was accessible after all: never carry
  // the "inaccessible" / "manual" flags onto the new document.
  const filteredTags = tagNamesOf(doc).filter(
    (tag) => tag !== TAG_UNREACHABLE && tag !== TAG_MANUAL,
  );
  console.log(
    `[readwise-full-content] Preserving ${filteredTags.length} tags: ${filteredTags.join(", ") || "(none)"}`,
  );

  // Validate the payload BEFORE replaceDocument deletes anything: the save
  // API rejects a blank title (400) and null characters (400), and by then
  // the original document is already gone.
  const safeHtml = html.replace(/\u0000/g, "");
  const safeTitle = (doc.title || "").trim() || titleFromHtml(safeHtml, canonicalUrl);
  if (!safeTitle) {
    console.warn(
      `[readwise-full-content] No usable title, leaving the document untouched — ${canonicalUrl}`,
    );
    await recordBlocked(doc.source_url, "complete", doc.title, null, doc.id);
    return { enriched: false };
  }

  // Replace the thin document with the full-content version. replaceDocument
  // deletes the original first, so any create failure leaves nothing: recover
  // by saving the validated payload again, and shout if that fails too.
  const payload = {
    url: canonicalUrl,
    html: safeHtml,
    should_clean_html: true,
    title: safeTitle,
    tags: filteredTags,
    location: doc.location,
    category: "article",
    saved_using: "readwise-full-content",
  };
  // Readwise rejects an empty string on optional fields with 400
  // ("This field may not be blank."): omit them instead of sending "".
  for (const key of ["author", "summary", "published_date", "image_url"]) {
    const value = doc[key];
    const hasValue = typeof value === "string" ? value.trim() !== "" : Boolean(value);
    if (hasValue) payload[key] = value;
  }

  try {
    await replaceDocument(token, doc.id, payload);
  } catch (err) {
    console.error(
      `[readwise-full-content] Replace failed AFTER delete — recovering by saving the payload again: ${canonicalUrl} (${err.message})`,
    );
    try {
      await createDocument(token, payload);
    } catch (retryErr) {
      console.error(
        `[readwise-full-content] DATA LOSS: document ${doc.id} deleted and could not be recreated — ${canonicalUrl} (${retryErr.message})`,
      );
      throw retryErr;
    }
  }

  await recordEnriched(canonicalUrl, safeTitle, extractedWords);

  console.log(
    `[readwise-full-content] ✓ Enriched: "${safeTitle}"` +
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
function looksLikeChallenge(html) {
  if (!html) return false;
  return (
    html.includes("cf-challenge-running") ||
    html.includes("challenge-platform") ||
    html.includes("Just a moment...") ||
    html.includes("Checking your browser")
  );
}

function isUsableHtml(html) {
  if (!html || html.length < MIN_HTML_SIZE) return false;
  // Cloudflare challenge pages are big enough to pass the size test, so the
  // markers are the only thing telling them apart from a real article.
  if (looksLikeChallenge(html)) return false;
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

/**
 * The source URL cannot be changed through the API (PATCH accepts title but
 * ignores url/source_url — verified 2026-10-28). When a document was saved
 * under a Google Alerts or tracker wrapper, the only way to fix it is to
 * create it under the real URL, then delete the wrapper.
 * Create first, delete second: a failure leaves the original intact.
 */
async function rebuildUnderResolvedUrl(token, doc, targetUrl) {
  try {
    const created = await createDocument(token, {
      url: targetUrl,
      location: doc.location || "archive",
      category: "article",
      tags: tagNamesOf(doc).filter(
        (tag) => tag !== TAG_UNREACHABLE && tag !== TAG_MANUAL,
      ),
      // Not "readwise-full-content": this document is not enriched yet, it
      // must stay a candidate (a paywall under the real URL still has to be
      // retried and tagged later).
      saved_using: "url-rebuild",
    });
    if (!created || !created.id) return false;
    if (created.id !== doc.id) {
      await deleteDocument(token, doc.id);
    }
    await clearBlocked(doc.source_url);
    await clearBlocked(targetUrl);
    console.log(
      `[readwise-full-content] URL fixed: ${doc.source_url} -> ${targetUrl}`,
    );
    return true;
  } catch (err) {
    console.warn(
      `[readwise-full-content] Could not rebuild under ${targetUrl}: ${err.message}`,
    );
    return false;
  }
}

/**
 * Every failure path goes through here: if the document was saved under a
 * wrapper URL, rebuild it under the real one BEFORE recording the failure.
 * Otherwise the wrapper stays in Reader and the article is never retried
 * under its real address.
 */
async function failEnrichment(token, doc, targetUrl, canonicalUrl, reason, tag) {
  if (targetUrl && targetUrl !== doc.source_url) {
    const rebuilt = await rebuildUnderResolvedUrl(
      token,
      doc,
      canonicalUrl || targetUrl,
    );
    if (rebuilt) return { enriched: false, rebuilt: true };
  }
  await recordBlocked(doc.source_url, reason, doc.title, null, doc.id);
  if (tag) await tagDocument(token, doc, tag);
  return { enriched: false };
}

/**
 * Normalise a URL for comparison only: drop tracking parameters so a manual
 * save (which keeps the page's own URL) still matches the wrapper's target.
 */
function comparableUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Remove the empty wrapper documents left behind by a manual "Save Full Page"
 * (the manual save lands under the real URL, the old Google/tracker entry
 * stays empty). A wrapper is deleted only when the real URL exists in the
 * archive: never remove the last copy of an article.
 */
async function cleanupWrapperDocuments() {
  const token = await getToken();
  if (!token) return { ok: false, error: "Readwise token not configured" };

  let docs = [];
  try {
    docs = await listDocuments(token, {
      location: "archive",
      maxPages: 25,
      pageDelayMs: 5000,
    });
  } catch (err) {
    return {
      ok: false,
      error: err.message?.startsWith("RATE_LIMITED")
        ? "Readwise rate limit reached while scanning the archive. Wait a minute, then retry."
        : err.message,
    };
  }

  const existing = new Set(docs.map((doc) => comparableUrl(doc.source_url || "")));
  const candidates = docs.filter((doc) => {
    if (!doc.source_url) return false;
    if ((Number(doc.word_count) || 0) >= BACKFILL_EMPTY_WORDS) return false;
    const target = resolveTargetUrl(doc.source_url);
    return target !== doc.source_url;
  });

  let deleted = 0;
  let kept = 0;
  let failed = 0;
  for (const doc of candidates) {
    const target = comparableUrl(resolveTargetUrl(doc.source_url));
    if (!existing.has(target)) {
      kept++;
      continue;
    }
    try {
      await deleteDocument(token, doc.id);
      await clearBlocked(doc.source_url);
      deleted++;
    } catch (err) {
      failed++;
      console.warn(
        `[readwise-full-content] Cleanup failed for ${doc.source_url}: ${err.message}`,
      );
      if (err.message?.startsWith("RATE_LIMITED")) {
        const wait = Math.max(60, Number(err.message.split(":")[1]) || 0);
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
    }
    await new Promise((r) => setTimeout(r, BACKFILL_DELAY_MS));
  }

  return { ok: true, scanned: docs.length, candidates: candidates.length, deleted, kept, failed };
}

/**
 * Re-run the enrichment for one blocked document, immediately.
 *
 * The blocked entry only keeps the URL and the Readwise id: the list API
 * cannot be filtered by URL, so the document is fetched back by id.
 * The block and the cooldown are cleared first, because enrichDocument
 * records whatever happens next (success in the enriched log, failure in the
 * blocked list).
 */
async function retryOneDocument(url) {
  const token = await getToken();
  if (!token) return { ok: false, error: "Readwise token not configured" };

  const blocked = await getBlockedUrls();
  const entry = blocked[url];
  if (!entry) return { ok: false, error: "Article is not in the blocked list" };
  if (!entry.id) {
    return {
      ok: false,
      error: "No Readwise id recorded for this article: run the archive backfill instead",
    };
  }

  let doc = null;
  try {
    const res = await fetch(
      `${READWISE_BASE}/v3/list/?id=${encodeURIComponent(entry.id)}&withHtmlContent=true`,
      { headers: { Authorization: `Token ${token}` } },
    );
    if (res.status === 429) {
      return { ok: false, error: "Readwise rate limit, try again in a minute" };
    }
    if (res.ok) {
      const data = await res.json();
      doc = (data.results || [])[0] || null;
    }
  } catch (err) {
    return { ok: false, error: `Could not reach Readwise (${err.message})` };
  }
  if (!doc) {
    return { ok: false, error: "Document not found in Readwise (deleted?)" };
  }

  const group = [url];
  delete blocked[url];
  for (const [otherUrl, other] of Object.entries(blocked)) {
    if (other.aliasOf === url) {
      group.push(otherUrl);
      delete blocked[otherUrl];
    }
  }
  await browser.storage.local.set({ blockedUrls: blocked });
  await clearProcessed([...group, doc.source_url, doc.url].filter(Boolean));

  const lowWordCount = await getLowWordCount();
  try {
    const result = await enrichDocument(token, doc, lowWordCount);
    return { ok: true, enriched: Boolean(result.enriched) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================================
// Archive backfill — one-shot repair of documents imported without content
// ============================================================================

/**
 * Progress record for the archive backfill, readable by the options page.
 * { running, cancelled, error, total, processed, enriched, skipped, failed,
 *   startedAt, finishedAt }
 */
async function getBackfillState() {
  const { backfill } = await browser.storage.local.get("backfill");
  return backfill || { running: false };
}

async function setBackfillState(patch) {
  const current = await getBackfillState();
  await browser.storage.local.set({ backfill: { ...current, ...patch } });
}

async function bumpBackfill(delta) {
  const current = await getBackfillState();
  const next = { ...current };
  for (const [key, value] of Object.entries(delta)) {
    next[key] = (next[key] || 0) + value;
  }
  await browser.storage.local.set({ backfill: next });
}

/**
 * Repair archived documents that were imported with metadata only (Pocket
 * migration, bare RSS items, Android share sheet): their text never reached
 * Readwise, so Reader shows them empty and the fiche pipeline can only fall
 * back to Jina.
 *
 * Readwise dedupes on URL and a re-save does not update the content, so each
 * document is deleted and re-created (replaceDocument) with the page fetched
 * here, cookies included — the only way to get past a paywall.
 *
 * One-shot and explicit: nothing runs unless the options page asks for it.
 */
async function runArchiveBackfill() {
  const current = await getBackfillState();
  if (current.running) return;

  const token = await getToken();
  if (!token) {
    await setBackfillState({ error: "Readwise token not configured" });
    return;
  }

  await setBackfillState({
    running: true,
    cancelled: false,
    error: null,
    total: 0,
    processed: 0,
    enriched: 0,
    skipped: 0,
    failed: 0,
    startedAt: Date.now(),
    finishedAt: null,
  });

  try {
    const lowWordCount = await getLowWordCount();

    // The archive is ~1200 documents: 13 pages at 100/page. The list API is
    // limited to 20 req/min, hence the 3s throttle inside listDocuments.
    // 13 pages at 5s spacing: ~12 requests/min, clear of the 20/min ceiling.
    let docs = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        docs = await listDocuments(token, {
          location: "archive",
          maxPages: 25,
          pageDelayMs: 5000,
        });
        break;
      } catch (err) {
        if (!err.message?.startsWith("RATE_LIMITED") || attempt === 4) throw err;
        // The quota window is a minute: Retry-After can be a couple of
        // seconds, which is never enough, so wait a full window.
        const wait = Math.max(60, Number(err.message.split(":")[1]) || 0);
        console.warn(
          `[readwise-full-content] Archive list rate limited, waiting ${wait}s (attempt ${attempt}/4)`,
        );
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
    }

    const targets = docs.filter((doc) => {
      const words = Number(doc.word_count) || 0;
      if (words >= BACKFILL_EMPTY_WORDS) return false;
      // Already enriched by this extension: re-scraping would loop.
      if (doc.source === "readwise-full-content") return false;
      if (!["article", "rss"].includes(doc.category)) return false;
      if (!doc.source_url) return false;
      try {
        const url = new URL(doc.source_url);
        if (url.hostname.includes("readwise.io")) return false;
        if (!url.protocol.startsWith("http")) return false;
      } catch {
        return false;
      }
      return true;
    });

    await setBackfillState({ total: targets.length });

    for (const doc of targets) {
      const state = await getBackfillState();
      if (state.cancelled) break;

      // Respect the paywall backoff: a terminal entry is not retried here.
      const blocked = await getBlockedEntry(doc.source_url);
      if (blocked) {
        const due =
          Boolean(blocked.nextAttemptAt) &&
          blocked.nextAttemptAt <= Date.now();
        if (!due) {
          // Older entries carry no Readwise id: record it while we have it.
          await rememberBlockedId(doc.source_url, doc.id);
          await bumpBackfill({ skipped: 1, processed: 1 });
          continue;
        }
      }

      try {
        const result = await enrichDocument(token, doc, lowWordCount);
        if (result.enriched) {
          await clearBlocked(doc.source_url);
          if (result.canonicalUrl && result.canonicalUrl !== doc.source_url) {
            await clearBlocked(result.canonicalUrl);
          }
          await bumpBackfill({ enriched: 1, processed: 1 });
        } else {
          await bumpBackfill({ failed: 1, processed: 1 });
        }
        await markProcessed(doc.source_url);
      } catch (err) {
        await bumpBackfill({ failed: 1, processed: 1 });
        if (err.message?.startsWith("RATE_LIMITED")) {
          const wait = Number(err.message.split(":")[1]) || 60;
          console.warn(`[readwise-full-content] Backfill rate limited, waiting ${wait}s`);
          await new Promise((r) => setTimeout(r, wait * 1000));
        } else {
          console.error(
            `[readwise-full-content] Backfill failed for ${doc.source_url}:`,
            err.message,
          );
        }
      }

      await new Promise((r) => setTimeout(r, BACKFILL_DELAY_MS));
    }
  } catch (err) {
    console.error("[readwise-full-content] Backfill aborted:", err.message);
    const friendly = err.message?.startsWith("RATE_LIMITED")
      ? "Readwise rate limit reached while scanning the archive (20 requests/min). Wait a few minutes, then start again."
      : err.message;
    await setBackfillState({ error: friendly });
  } finally {
    await setBackfillState({ running: false, finishedAt: Date.now() });
  }
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

        const safeHtml = (message.html || "").replace(/\u0000/g, "");
        const safeTitle =
          (message.title || "").trim() || titleFromHtml(safeHtml, message.url);
        const manualPayload = {
          url: message.url,
          html: safeHtml,
          should_clean_html: true,
          title: safeTitle,
          location: "new",
          category: "article",
          saved_using: "readwise-full-content",
        };
        if (message.author) manualPayload.author = message.author;

        const result = await createDocument(token, manualPayload);

        if (result.alreadyExisted) {
          const replaced = await replaceDocument(token, result.id, manualPayload);
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

  // Remove empty wrapper documents (options page)
  if (message.type === "CLEANUP_WRAPPERS") {
    (async () => {
      sendResponse(await cleanupWrapperDocuments());
    })();
    return true;
  }

  // Re-run one blocked article (options page, Retry row)
  if (message.type === "RETRY_URL") {
    (async () => {
      sendResponse(await retryOneDocument(message.url));
    })();
    return true;
  }

  // Start the one-shot archive backfill (options page)
  if (message.type === "START_BACKFILL") {
    (async () => {
      await runArchiveBackfill();
    })();
    sendResponse({ started: true });
  }

  // Ask the running backfill to stop after the current document
  if (message.type === "CANCEL_BACKFILL") {
    (async () => {
      await setBackfillState({ cancelled: true });
    })();
    sendResponse({ success: true });
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
