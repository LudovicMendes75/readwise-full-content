/**
 * Options page — lists what the extension did with the documents it looked at.
 *
 * Two sources are merged into one table:
 *  - blocked articles (`blockedUrls`), with the reason and the retry schedule;
 *  - successful enrichments (`enrichedUrls`), so a backfill can be judged on
 *    results, not only on failures.
 *
 * Filtering (text on article/site, status) and sorting (article, status,
 * attempts, next attempt) are client-side only: the record is small and lives
 * in storage.local.
 *
 * Blocked rows can be retried: the record is dropped and the 24h cooldown is
 * cleared, so the next poll (at most 2 minutes) tries the article again.
 */

const els = {
  empty: document.getElementById("empty"),
  toolbar: document.getElementById("toolbar"),
  table: document.getElementById("table"),
  rows: document.getElementById("rows"),
  filterText: document.getElementById("filter-text"),
  filterReason: document.getElementById("filter-reason"),
  count: document.getElementById("count"),
  retryPaywalls: document.getElementById("retry-paywalls"),
  forgetManual: document.getElementById("forget-manual"),
  forgetComplete: document.getElementById("forget-complete"),
  cleanupWrappers: document.getElementById("cleanup-wrappers"),
  startBackfill: document.getElementById("start-backfill"),
  cancelBackfill: document.getElementById("cancel-backfill"),
  backfillProgress: document.getElementById("backfill-progress"),
  backfillStatus: document.getElementById("backfill-status"),
};

const SORT_LABELS = {
  title: "Article",
  status: "Status",
  attempts: "Attempts",
  nextAttemptAt: "Next attempt",
};

const state = {
  query: "",
  status: "all",
  sortKey: "nextAttemptAt",
  sortDir: "asc",
};

async function getBlocked() {
  const { blockedUrls } = await browser.storage.local.get("blockedUrls");
  return blockedUrls || {};
}

async function getEnriched() {
  const { enrichedUrls } = await browser.storage.local.get("enrichedUrls");
  return Array.isArray(enrichedUrls) ? enrichedUrls : [];
}

async function saveBlocked(blocked) {
  await browser.storage.local.set({ blockedUrls: blocked });
}

/**
 * Drop URLs from the 24h "recently processed" cooldown. Without this, a Retry
 * click would look like a no-op: the poll would skip the URL for up to 24h.
 */
async function clearProcessed(urls) {
  if (urls.length === 0) return;
  const { processedUrls } = await browser.storage.local.get("processedUrls");
  const processed = processedUrls || {};
  for (const url of urls) delete processed[url];
  await browser.storage.local.set({ processedUrls: processed });
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString();
}

function formatNext(row) {
  if (row.status === "enriched") return "—";
  if (row.status === "complete") return "—";
  if (row.status === "manual") return "—";
  if (!row.nextAttemptAt) return "no automatic retry";
  return formatDate(row.nextAttemptAt);
}

/**
 * One row per article. Blocked entries carry their canonical alias (hidden
 * here, removed together on Retry); enriched entries come from the log.
 */
async function loadRows() {
  const [blocked, enriched] = await Promise.all([getBlocked(), getEnriched()]);
  const rows = [];

  for (const [url, entry] of Object.entries(blocked)) {
    if (entry.aliasOf) continue;
    rows.push({
      url,
      title: entry.title || "",
      status: entry.reason,
      attempts: entry.attempts || 0,
      nextAttemptAt: entry.nextAttemptAt || null,
      at: entry.lastAttemptAt || null,
      blocked: true,
    });
  }

  for (const entry of enriched) {
    if (blocked[entry.url]) continue; // a later failure supersedes the success
    rows.push({
      url: entry.url,
      title: entry.title || "",
      status: "enriched",
      attempts: null,
      nextAttemptAt: null,
      at: entry.at || null,
      blocked: false,
    });
  }

  return rows;
}

function matchesFilters(row) {
  if (state.status !== "all" && row.status !== state.status) return false;
  const query = state.query.trim().toLowerCase();
  if (!query) return true;
  return (
    (row.title || "").toLowerCase().includes(query) ||
    hostOf(row.url).toLowerCase().includes(query) ||
    row.url.toLowerCase().includes(query)
  );
}

function sortValue(row, key) {
  switch (key) {
    case "title":
      return (row.title || row.url).toLowerCase();
    case "status":
      return row.status;
    case "attempts":
      return row.attempts || 0;
    default:
      return row.nextAttemptAt || Number.MAX_SAFE_INTEGER;
  }
}

function sortRows(rows) {
  return rows.sort((a, b) => {
    const va = sortValue(a, state.sortKey);
    const vb = sortValue(b, state.sortKey);
    const cmp =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb));
    return state.sortDir === "asc" ? cmp : -cmp;
  });
}

function updateSortIndicators() {
  for (const button of document.querySelectorAll("button.sort")) {
    const key = button.dataset.key;
    const label = SORT_LABELS[key];
    if (key === state.sortKey) {
      button.textContent = `${label} ${state.sortDir === "asc" ? "▲" : "▼"}`;
    } else {
      button.textContent = label;
    }
  }
}

function statusLabel(status) {
  if (status === "paywall") return "Paywall";
  if (status === "complete") return "Complete";
  if (status === "manual") return "Manual";
  return "Enriched";
}

function buildRow(row) {
  const tr = document.createElement("tr");

  const titleCell = document.createElement("td");
  // Clickable title: opens the article itself so the status can be checked
  // by hand (paywall really there? article really complete?).
  const title = document.createElement("a");
  title.className = "title";
  title.href = row.url;
  title.target = "_blank";
  title.rel = "noreferrer";
  title.textContent = row.title || row.url;
  // Full text on hover: the cell truncates to two lines.
  title.title = row.title || row.url;
  const meta = document.createElement("div");
  meta.className = "host";
  const parts = [hostOf(row.url)];
  if (row.status === "enriched" && row.at) parts.push(`enriched ${formatDate(row.at)}`);
  meta.textContent = parts.join(" · ");
  titleCell.append(title, meta);

  const statusCell = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `badge ${row.status}`;
  badge.textContent = statusLabel(row.status);
  statusCell.append(badge);

  const attemptsCell = document.createElement("td");
  attemptsCell.className = "muted";
  attemptsCell.textContent = row.attempts === null ? "—" : String(row.attempts);

  const nextCell = document.createElement("td");
  nextCell.className = "muted";
  nextCell.textContent = formatNext(row);

  const actionCell = document.createElement("td");
  if (row.blocked) {
    // Forget: the article has been handled elsewhere (manually, or given up
    // on). Drop the record without retrying, so it leaves the list.
    const forget = document.createElement("button");
    forget.textContent = "Forget";
    forget.addEventListener("click", async () => {
      const current = await getBlocked();
      const group = [row.url];
      delete current[row.url];
      for (const [otherUrl, other] of Object.entries(current)) {
        if (other.aliasOf === row.url) {
          group.push(otherUrl);
          delete current[otherUrl];
        }
      }
      await saveBlocked(current);
      await clearProcessed(group);
      await render();
    });
    actionCell.append(forget);

    const retry = document.createElement("button");
    retry.textContent = "Retry";
    retry.addEventListener("click", async () => {
      // Re-runs the enrichment now, in the background: clearing the record
      // alone did nothing for archived documents, which only the backfill
      // scans.
      retry.disabled = true;
      retry.textContent = "Retrying…";
      const response = await browser.runtime.sendMessage({
        type: "RETRY_URL",
        url: row.url,
      });
      await render();
      if (!response?.ok) {
        window.alert(`Retry failed: ${response?.error || "unknown error"}`);
      }
    });
    actionCell.append(retry);
  }

  tr.append(titleCell, statusCell, attemptsCell, nextCell, actionCell);
  return tr;
}

async function render() {
  const all = await loadRows();
  const visible = sortRows(all.filter(matchesFilters));

  els.empty.hidden = all.length > 0;
  els.toolbar.hidden = all.length === 0;
  // Keep the table (and its sortable headers) visible when a filter simply
  // matches nothing, so the user can see why and clear the filter.
  els.table.hidden = all.length === 0;
  els.rows.textContent = "";
  els.count.textContent =
    all.length === 0 ? "" : `${visible.length} of ${all.length} shown`;

  if (all.length > 0 && visible.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "muted";
    td.textContent = "No article matches these filters.";
    tr.append(td);
    els.rows.append(tr);
  }

  for (const row of visible) {
    els.rows.append(buildRow(row));
  }

  updateSortIndicators();
}

async function forgetByReason(reason) {
  const blocked = await getBlocked();
  const removed = [];
  for (const [url, entry] of Object.entries(blocked)) {
    if (entry.reason === reason) {
      removed.push(url);
      delete blocked[url];
    }
  }
  await saveBlocked(blocked);
  await clearProcessed(removed);
  await render();
}

// ---------------------------------------------------------------- backfill

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(seconds % 60).padStart(2, "0")}s`;
}

async function refreshBackfill() {
  const { backfill } = await browser.storage.local.get("backfill");

  els.startBackfill.disabled = Boolean(backfill?.running);
  els.cancelBackfill.hidden = !backfill?.running;

  if (!backfill || (!backfill.running && !backfill.finishedAt && !backfill.error)) {
    els.backfillProgress.hidden = true;
    els.backfillStatus.textContent = "Never run.";
    return;
  }

  const total = backfill.total || 0;
  const processed = backfill.processed || 0;
  els.backfillProgress.hidden = total === 0;
  els.backfillProgress.max = Math.max(total, 1);
  els.backfillProgress.value = processed;

  const counts = `${backfill.enriched || 0} enriched, ${backfill.failed || 0} failed, ${
    backfill.skipped || 0
  } skipped`;

  if (backfill.error) {
    els.backfillStatus.textContent = `Failed: ${backfill.error}`;
  } else if (backfill.running) {
    els.backfillStatus.textContent = total
      ? `Running — ${processed}/${total} · ${counts}`
      : "Scanning the archive…";
  } else if (backfill.finishedAt && backfill.startedAt) {
    const duration = formatDuration(backfill.finishedAt - backfill.startedAt);
    els.backfillStatus.textContent = `Finished in ${duration} — ${processed}/${total} · ${counts}`;
  }
}

// ---------------------------------------------------------------- events

for (const button of document.querySelectorAll("button.sort")) {
  button.addEventListener("click", () => {
    const key = button.dataset.key;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = key;
      state.sortDir = "asc";
    }
    render();
  });
}

els.filterText.addEventListener("input", () => {
  state.query = els.filterText.value;
  render();
});

els.filterReason.addEventListener("change", () => {
  state.status = els.filterReason.value;
  render();
});

els.retryPaywalls.addEventListener("click", () => forgetByReason("paywall"));
els.forgetManual.addEventListener("click", () => forgetByReason("manual"));
els.forgetComplete.addEventListener("click", () => forgetByReason("complete"));

els.cleanupWrappers.addEventListener("click", async () => {
  const proceed = window.confirm(
    "Delete archived documents that are empty and only carry a Google/tracker URL, " +
      "when the real article already exists in the archive. Articles with no other " +
      "copy are kept. Continue?",
  );
  if (!proceed) return;
  els.cleanupWrappers.disabled = true;
  els.cleanupWrappers.textContent = "Cleaning…";
  const result = await browser.runtime.sendMessage({ type: "CLEANUP_WRAPPERS" });
  els.cleanupWrappers.disabled = false;
  els.cleanupWrappers.textContent = "Clean up empty wrappers";
  await render();
  window.alert(
    result?.ok
      ? `Scanned ${result.scanned} · wrappers found ${result.candidates} · ` +
          `${result.deleted} deleted, ${result.kept} kept (no other copy), ${result.failed} failed.`
      : `Cleanup failed: ${result?.error || "unknown error"}`,
  );
});

els.startBackfill.addEventListener("click", async () => {
  const proceed = window.confirm(
    "This will delete and re-create the archived documents that have no content. " +
      "The operation runs in the background and can take 20 to 45 minutes. Continue?",
  );
  if (!proceed) return;
  await browser.runtime.sendMessage({ type: "START_BACKFILL" });
  await refreshBackfill();
});

els.cancelBackfill.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "CANCEL_BACKFILL" });
  await refreshBackfill();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.blockedUrls || changes.enrichedUrls) render();
  if (changes.backfill) refreshBackfill();
});

render();
refreshBackfill();
