/**
 * Options page — lists the articles the extension could not enrich, with the
 * reason and the retry schedule.
 *
 * Filtering (text on article/site, reason) and sorting (article, reason,
 * attempts, next attempt) are client-side only: the whole record is small and
 * lives in storage.local.
 *
 * Each row can be retried individually: the record is dropped, so the next
 * poll (at most 2 minutes) tries the article again from scratch. The two
 * global buttons do the same by reason.
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
  forgetComplete: document.getElementById("forget-complete"),
};

const SORT_LABELS = {
  title: "Article",
  reason: "Reason",
  attempts: "Attempts",
  nextAttemptAt: "Next attempt",
};

const state = {
  query: "",
  reason: "all",
  sortKey: "nextAttemptAt",
  sortDir: "asc",
};

async function getBlocked() {
  const { blockedUrls } = await browser.storage.local.get("blockedUrls");
  return blockedUrls || {};
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

function formatNext(entry) {
  if (entry.reason === "complete") return "—";
  if (!entry.nextAttemptAt) return "no automatic retry";
  return new Date(entry.nextAttemptAt).toLocaleString();
}

/** Canonical aliases (same article under another URL) are never listed. */
function listableEntries(blocked) {
  return Object.entries(blocked).filter(([, entry]) => !entry.aliasOf);
}

function matchesFilters(url, entry) {
  if (state.reason !== "all" && entry.reason !== state.reason) return false;
  const query = state.query.trim().toLowerCase();
  if (!query) return true;
  return (
    (entry.title || "").toLowerCase().includes(query) ||
    hostOf(url).toLowerCase().includes(query) ||
    url.toLowerCase().includes(query)
  );
}

function sortValue(url, entry, key) {
  switch (key) {
    case "title":
      return (entry.title || url).toLowerCase();
    case "reason":
      return entry.reason;
    case "attempts":
      return entry.attempts || 0;
    default:
      return entry.nextAttemptAt || Number.MAX_SAFE_INTEGER;
  }
}

function sortEntries(entries) {
  return entries.sort((a, b) => {
    const va = sortValue(a[0], a[1], state.sortKey);
    const vb = sortValue(b[0], b[1], state.sortKey);
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

function buildRow(url, entry) {
  const tr = document.createElement("tr");

  const titleCell = document.createElement("td");
  // Clickable title: opens the article itself so the reason can be checked
  // by hand (paywall really there? article really complete?).
  const title = document.createElement("a");
  title.className = "title";
  title.href = url;
  title.target = "_blank";
  title.rel = "noreferrer";
  title.textContent = entry.title || url;
  const host = document.createElement("div");
  host.className = "host";
  host.textContent = hostOf(url);
  titleCell.append(title, host);

  const reasonCell = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `badge ${entry.reason}`;
  badge.textContent = entry.reason === "paywall" ? "Paywall" : "Complete";
  reasonCell.append(badge);

  const attemptsCell = document.createElement("td");
  attemptsCell.className = "muted";
  attemptsCell.textContent = String(entry.attempts || 0);

  const nextCell = document.createElement("td");
  nextCell.className = "muted";
  nextCell.textContent = formatNext(entry);

  const actionCell = document.createElement("td");
  const retry = document.createElement("button");
  retry.textContent = "Retry";
  retry.addEventListener("click", async () => {
    const current = await getBlocked();
    const group = [url];
    delete current[url];
    for (const [otherUrl, other] of Object.entries(current)) {
      if (other.aliasOf === url) {
        group.push(otherUrl);
        delete current[otherUrl];
      }
    }
    await saveBlocked(current);
    await clearProcessed(group);
    await render();
  });
  actionCell.append(retry);

  tr.append(titleCell, reasonCell, attemptsCell, nextCell, actionCell);
  return tr;
}

async function render() {
  const blocked = await getBlocked();
  const all = listableEntries(blocked);
  const visible = sortEntries(all.filter(([url, entry]) => matchesFilters(url, entry)));

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

  for (const [url, entry] of visible) {
    els.rows.append(buildRow(url, entry));
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
  state.reason = els.filterReason.value;
  render();
});

els.retryPaywalls.addEventListener("click", () => forgetByReason("paywall"));
els.forgetComplete.addEventListener("click", () => forgetByReason("complete"));

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.blockedUrls) render();
});

render();
