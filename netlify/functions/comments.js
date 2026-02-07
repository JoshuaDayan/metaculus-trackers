// Netlify Function: Read public comments stored as Netlify Form submissions.
//
// Storage: Netlify Forms (write via HTML form POST; read via Netlify API using a server-side token).
// This avoids exposing any credentials in the browser and keeps the site static.

const THREADS = {
  currency: { formName: "sf-comments-currency" },
  bond: { formName: "sf-comments-bond" },
};

const MAX_COMMENTS = 200;
const PER_PAGE = 100;
const MAX_PAGES = 3;

const DEFAULT_CDN_CACHE_SECONDS = 10;
const DEFAULT_STALE_WHILE_REVALIDATE_SECONDS = 60;

const FORMS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let formsCache = { fetchedAt: 0, byName: {} };

function formatTimestampUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    d.toLocaleString("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "long",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }) + " GMT"
  );
}

function sanitizeText(value, { maxLen }) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLen) return trimmed.slice(0, maxLen);
  return trimmed;
}

function sanitizeHandle(value) {
  const s = sanitizeText(value, { maxLen: 40 });
  if (!s) return "AnonymousForecaster";
  // Keep it simple and safe for display.
  return s.replace(/[^\w.-]/g, "").slice(0, 40) || "AnonymousForecaster";
}

async function fetchJson(url, token) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "Mozilla/5.0 (Netlify comments)",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    throw new Error(`Netlify API request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function getFormsByName({ siteId, token }) {
  const now = Date.now();
  if (formsCache.fetchedAt && now - formsCache.fetchedAt < FORMS_CACHE_TTL_MS) {
    return formsCache.byName;
  }

  const url = `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/forms`;
  const forms = await fetchJson(url, token);
  const byName = {};
  if (Array.isArray(forms)) {
    for (const f of forms) {
      const name = typeof f?.name === "string" ? f.name : null;
      const id = typeof f?.id === "string" ? f.id : null;
      if (name && id) byName[name] = id;
    }
  }

  formsCache = { fetchedAt: now, byName };
  return byName;
}

async function fetchSubmissions({ formId, token, maxItems }) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES && out.length < maxItems; page += 1) {
    const url = `https://api.netlify.com/api/v1/forms/${encodeURIComponent(
      formId
    )}/submissions?per_page=${PER_PAGE}&page=${page}`;
    const batch = await fetchJson(url, token);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return out.slice(0, maxItems);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "method_not_allowed" }),
      };
    }

    const qs = event.queryStringParameters || {};
    const thread = typeof qs.thread === "string" ? qs.thread : "";
    const threadConfig = THREADS[thread] || null;
    if (!threadConfig) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        body: JSON.stringify({ error: "invalid_thread" }),
      };
    }

    const token =
      process.env.NETLIFY_API_TOKEN ||
      process.env.NETLIFY_ACCESS_TOKEN ||
      process.env.NETLIFY_TOKEN ||
      "";
    const siteId = process.env.SITE_ID || process.env.NETLIFY_SITE_ID || "";
    if (!token || !siteId) {
      return {
        statusCode: 501,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        body: JSON.stringify({ error: "comments_not_configured" }),
      };
    }

    const fetchedAt = new Date().toISOString();
    const byName = await getFormsByName({ siteId, token });
    const formId = byName[threadConfig.formName] || null;
    if (!formId) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        body: JSON.stringify({ error: "form_not_found" }),
      };
    }

    const submissions = await fetchSubmissions({ formId, token, maxItems: MAX_COMMENTS });

    const comments = [];
    for (const s of submissions) {
      const message = sanitizeText(s?.data?.message, { maxLen: 800 });
      if (!message) continue;
      comments.push({
        id: typeof s?.id === "string" ? s.id : null,
        createdAt: typeof s?.created_at === "string" ? s.created_at : null,
        handle: sanitizeHandle(s?.data?.handle),
        message,
      });
    }

    comments.sort((a, b) => {
      const at = a.createdAt || "";
      const bt = b.createdAt || "";
      if (at < bt) return -1;
      if (at > bt) return 1;
      return 0;
    });

    const body = {
      thread,
      formName: threadConfig.formName,
      fetchedAt,
      lastUpdated: formatTimestampUtc(fetchedAt),
      comments,
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=0, must-revalidate",
        "Netlify-CDN-Cache-Control": `public, max-age=${DEFAULT_CDN_CACHE_SECONDS}, stale-while-revalidate=${DEFAULT_STALE_WHILE_REVALIDATE_SECONDS}`,
      },
      body: JSON.stringify(body),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        error: "comments_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};

