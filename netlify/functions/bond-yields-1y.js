// Netlify Function: 1-year 10Y government yield comparison (DE/US/GB/FR/IT).
//
// Germany (DE) uses Deutsche Bundesbank (same source as the main tracker).
// Others use FRED (Federal Reserve Bank of St. Louis) CSV exports.

const BUNDESBANK_SERIES_ID = "BBSSY.D.REN.EUR.A630.000000WT1010.A";
const BUNDESBANK_URL =
  "https://api.statistiken.bundesbank.de/rest/data/BBSSY/D.REN.EUR.A630.000000WT1010.A";

const FRED = {
  US: { id: "DGS10", name: "United States" },
  GB: { id: "IRLTLT01GBD156N", name: "United Kingdom" },
  FR: { id: "IRLTLT01FRD156N", name: "France" },
  IT: { id: "IRLTLT01ITD156N", name: "Italy" },
};

const WINDOW_DAYS = 365;
const DEFAULT_CDN_CACHE_SECONDS = 60 * 60; // 1 hour
const DEFAULT_STALE_WHILE_REVALIDATE_SECONDS = 24 * 60 * 60; // 1 day

function parseISODate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function isWeekday(date) {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

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

function intersection(a, b) {
  const out = new Set();
  for (const v of a) {
    if (b.has(v)) out.add(v);
  }
  return out;
}

async function fetchBundesbankSeries({ startDate, endDate }) {
  const res = await fetch(BUNDESBANK_URL, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Netlify bond-yields-1y)" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    throw new Error(`Bundesbank request failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();

  const obs = json?.data?.dataSets?.[0]?.series?.["0:0:0:0:0:0"]?.observations;
  if (!obs || typeof obs !== "object") {
    throw new Error("Bundesbank response missing observations");
  }

  const values = json?.data?.structure?.dimensions?.observation?.[0]?.values;
  if (!Array.isArray(values)) throw new Error("Bundesbank response missing observation values");

  const keys = Object.keys(obs).map((k) => Number(k)).filter((n) => Number.isFinite(n));
  const sorted = keys.sort((a, b) => a - b);

  const out = [];
  for (const idx of sorted) {
    const date = values[idx]?.id || values[idx]?.name || null;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (date < startDate || date > endDate) continue;

    const dateObj = parseISODate(date);
    if (!dateObj || !isWeekday(dateObj)) continue;

    const raw = obs[String(idx)]?.[0];
    const y = Math.round(Number(raw) * 100) / 100;
    if (!Number.isFinite(y) || y === 0) continue;

    out.push({ date, yield: y });
  }

  return out;
}

async function fetchFredMultiSeries(seriesIds, { startDate, endDate }) {
  const params = new URLSearchParams({ id: seriesIds.join(","), cosd: startDate, coed: endDate });
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?${params.toString()}`;

  const res = await fetch(url, {
    headers: { Accept: "text/csv", "User-Agent": "Mozilla/5.0 (Netlify bond-yields-1y)" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    throw new Error(`FRED request failed: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("FRED response too short");

  const header = lines[0].split(",").map((s) => s.trim());
  if (!header.length || header[0].toUpperCase() !== "DATE") {
    throw new Error("FRED response header missing DATE column");
  }
  const ids = header.slice(1);
  if (!ids.length) throw new Error("FRED response missing series columns");

  const outById = Object.fromEntries(ids.map((id) => [id, []]));

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(",");
    const date = (cols[0] || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (date < startDate || date > endDate) continue;

    const dateObj = parseISODate(date);
    if (!dateObj || !isWeekday(dateObj)) continue;

    for (let j = 0; j < ids.length; j += 1) {
      const id = ids[j];
      const valueStr = (cols[j + 1] || "").trim();
      if (!id) continue;
      if (!valueStr || valueStr === ".") continue;
      const y = Math.round(Number(valueStr) * 100) / 100;
      if (!Number.isFinite(y)) continue;
      outById[id].push({ date, yield: y });
    }
  }

  return outById;
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const asofParam = typeof qs.asof === "string" ? qs.asof : null;

    const asOfLimit = (asofParam && parseISODate(asofParam)) || new Date(Date.now());
    const endDate = toISODate(asOfLimit);
    const startDate = toISODate(addDays(asOfLimit, -WINDOW_DAYS));

    const fetchedAt = new Date().toISOString();

    const errors = {};
    const series = { DE: [], US: [], GB: [], FR: [], IT: [] };

    const fredIds = Object.values(FRED).map((v) => v.id);
    const [deRes, fredRes] = await Promise.allSettled([
      fetchBundesbankSeries({ startDate, endDate }),
      fetchFredMultiSeries(fredIds, { startDate, endDate }),
    ]);

    if (deRes.status === "fulfilled") {
      series.DE = deRes.value;
    } else {
      errors.DE = deRes.reason instanceof Error ? deRes.reason.message : String(deRes.reason);
    }

    if (fredRes.status === "fulfilled") {
      const outById = fredRes.value || {};
      series.US = Array.isArray(outById[FRED.US.id]) ? outById[FRED.US.id] : [];
      series.GB = Array.isArray(outById[FRED.GB.id]) ? outById[FRED.GB.id] : [];
      series.FR = Array.isArray(outById[FRED.FR.id]) ? outById[FRED.FR.id] : [];
      series.IT = Array.isArray(outById[FRED.IT.id]) ? outById[FRED.IT.id] : [];
    } else {
      errors.FRED = fredRes.reason instanceof Error ? fredRes.reason.message : String(fredRes.reason);
    }

    const availableCodes = Object.keys(series).filter((code) => series[code] && series[code].length);
    if (!availableCodes.length) {
      throw new Error(`No yield series available (${Object.values(errors).join("; ") || "unknown error"})`);
    }

    // Latest common date across all series (helps the UI display an "as of").
    let common = null;
    for (const code of availableCodes) {
      const set = new Set((series[code] || []).map((p) => p.date));
      common = common ? intersection(common, set) : set;
    }
    const commonDates = common && common.size ? Array.from(common).sort() : [];
    let asOfDate = commonDates.length ? commonDates.at(-1) : null;
    if (!asOfDate) {
      const first = availableCodes[0];
      asOfDate = series[first][series[first].length - 1].date || null;
    }

    const body = {
      window: "1y",
      startDate,
      endDate,
      asOfDate,
      fetchedAt,
      lastUpdated: formatTimestampUtc(fetchedAt),
      errors: Object.keys(errors).length ? errors : null,
      countries: {
        DE: {
          name: "Germany",
          provider: "Deutsche Bundesbank",
          seriesId: BUNDESBANK_SERIES_ID,
          url: BUNDESBANK_URL,
        },
        US: { name: FRED.US.name, provider: "FRED", seriesId: FRED.US.id },
        GB: { name: FRED.GB.name, provider: "FRED", seriesId: FRED.GB.id },
        FR: { name: FRED.FR.name, provider: "FRED", seriesId: FRED.FR.id },
        IT: { name: FRED.IT.name, provider: "FRED", seriesId: FRED.IT.id },
      },
      series,
      source: {
        germany: { provider: "Deutsche Bundesbank", url: BUNDESBANK_URL },
        others: { provider: "FRED", url: "https://fred.stlouisfed.org/" },
      },
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
        error: "bond_yields_1y_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
