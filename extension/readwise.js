/**
 * Readwise Reader API client.
 *
 * Shared between background.js and popup.js.
 */

const READWISE_BASE = "https://readwise.io/api";

/**
 * Get the stored Readwise token.
 */
async function getToken() {
  const { readwiseToken } = await browser.storage.local.get("readwiseToken");
  return readwiseToken || null;
}

/**
 * Validate a Readwise token.
 * Returns true if valid (204), false otherwise.
 */
async function validateToken(token) {
  try {
    const res = await fetch(`${READWISE_BASE}/v2/auth/`, {
      headers: { Authorization: `Token ${token}` },
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

/**
 * Fetch recent documents from Readwise Reader.
 *
 * Supports pagination via `maxPages` — when set to > 1, follows
 * `nextPageCursor` to fetch additional pages of results.
 *
 * @param {string} token
 * @param {object} opts
 * @param {string} [opts.updatedAfter] - ISO 8601 timestamp
 * @param {string} [opts.location] - new, later, shortlist, archive, feed
 * @param {number} [opts.limit] - 1-100 (default 100)
 * @param {number} [opts.maxPages] - Max pages to fetch (default 1)
 * @param {number} [opts.pageDelayMs] - Delay between pages (default 3000)
 * @param {boolean} [opts.withHtmlContent] - Include HTML content
 * @returns {Promise<Array>} List of documents
 */
async function listDocuments(token, opts = {}) {
  const params = new URLSearchParams();
  if (opts.updatedAfter) params.set("updatedAfter", opts.updatedAfter);
  if (opts.location) params.set("location", opts.location);
  if (opts.withHtmlContent) params.set("withHtmlContent", "true");
  params.set("limit", String(opts.limit || 100));

  let allResults = [];
  let nextUrl = `${READWISE_BASE}/v3/list/?${params.toString()}`;
  let pages = 0;
  const maxPages = opts.maxPages || 1;

  while (nextUrl && pages < maxPages) {
    const res = await fetch(nextUrl, {
      headers: { Authorization: `Token ${token}` },
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After") || "60";
      throw new Error(`RATE_LIMITED:${retryAfter}`);
    }

    if (!res.ok) {
      throw new Error(`Readwise list failed: ${res.status}`);
    }

    const data = await res.json();
    allResults = allResults.concat(data.results || []);

    // API pagination: nextPageCursor is a cursor token, NOT a URL — it must
    // be passed back as the "pageCursor" query parameter. Fetching the raw
    // cursor as a URL throws TypeError: NetworkError (upstream bug: every
    // poll with >100 recently-modified documents failed on page 2).
    if (data.nextPageCursor) {
      params.set("pageCursor", data.nextPageCursor);
      nextUrl = `${READWISE_BASE}/v3/list/?${params.toString()}`;
    } else {
      nextUrl = null;
    }
    pages++;

    // Throttle between pages: Readwise's list API allows 20 requests per
    // minute per token, so 3s is the floor. A long scan (archive) passes a
    // larger delay to stay clear of the ceiling even with other callers.
    if (nextUrl && pages < maxPages) {
      await new Promise((resolve) =>
        setTimeout(resolve, opts.pageDelayMs || 3000),
      );
    }
  }

  return allResults;
}

/**
 * Replace the tag list of an existing document.
 * The bulk update endpoint expects the full list: pass the existing tags plus
 * the new one, never just the new one.
 */
async function updateDocumentTags(token, documentId, tagNames) {
  const res = await fetch(`${READWISE_BASE}/v3/bulk_update/`, {
    method: "PATCH",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ updates: [{ id: documentId, tags: tagNames }] }),
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After") || "60";
    throw new Error(`RATE_LIMITED:${retryAfter}`);
  }
  if (res.status !== 200 && res.status !== 207) {
    throw new Error(`Readwise bulk_update failed: ${res.status}`);
  }
  return true;
}

/**
 * Delete a document from Readwise Reader.
 */
async function deleteDocument(token, documentId) {
  const res = await fetch(`${READWISE_BASE}/v3/delete/${documentId}/`, {
    method: "DELETE",
    headers: { Authorization: `Token ${token}` },
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After") || "60";
    throw new Error(`RATE_LIMITED:${retryAfter}`);
  }

  return res.status === 204 || res.status === 404;
}

/**
 * Create a document in Readwise Reader with full HTML content.
 */
async function createDocument(token, doc) {
  const bodyJson = JSON.stringify(doc);
  console.log(
    `[readwise-full-content] Creating document: url=${doc.url} html=${(doc.html || "").length} bytes, payload=${bodyJson.length} bytes`,
  );

  const res = await fetch(`${READWISE_BASE}/v3/save/`, {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    body: bodyJson,
  });

  console.log(
    `[readwise-full-content] Create response: ${res.status} ${res.statusText}`,
  );

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After") || "60";
    throw new Error(`RATE_LIMITED:${retryAfter}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Readwise save failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  if (res.status === 200) {
    console.warn(
      `[readwise-full-content] Document already existed (${data.id}) — content was NOT updated`,
    );
  }

  return {
    id: data.id,
    url: data.url,
    alreadyExisted: res.status === 200,
  };
}

/**
 * Replace a document's content by deleting and re-creating it.
 *
 * Readwise has no content-update endpoint. URL is the dedup key —
 * POSTing the same URL returns the existing doc (200) without updating.
 * So we must delete first, then create with new HTML.
 *
 * @param {string} token
 * @param {string} existingId - ID of the document to replace
 * @param {object} doc - Document creation payload (url, html, title, etc.)
 */
async function replaceDocument(token, existingId, doc) {
  console.log(
    `[readwise-full-content] Replacing document ${existingId} with url=${doc.url}`,
  );

  await deleteDocument(token, existingId);

  // Brief pause for deletion to propagate
  await new Promise((r) => setTimeout(r, 2000));

  const result = await createDocument(token, doc);

  // If the document already existed under this URL, it means the delete
  // didn't clear the URL dedup, or another document has this URL.
  // Try deleting that one too and creating again.
  if (result.alreadyExisted) {
    console.warn(
      `[readwise-full-content] URL still occupied (${result.id}), deleting and retrying...`,
    );
    await deleteDocument(token, result.id);
    await new Promise((r) => setTimeout(r, 2000));
    return createDocument(token, doc);
  }

  return result;
}
