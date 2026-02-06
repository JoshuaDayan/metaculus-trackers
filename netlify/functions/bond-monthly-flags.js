// Netlify Function: Monthly Bund ±20bp breach flags (historical) from Deutsche Bundesbank API.
//
// Default window: 2025-01 through 2026-01 (inclusive), as requested.

const SERIES_ID = "BBSSY.D.REN.EUR.A630.000000WT1010.A";
const BASE_URL =
  "https://api.statistiken.bundesbank.de/rest/data/BBSSY/D.REN.EUR.A630.000000WT1010.A";

const DEFAULT_START_MONTH = "2025-01";
const DEFAULT_END_MONTH = "2026-01";
const THRESHOLD_BP = 20;

const DEFAULT_CDN_CACHE_SECONDS = 6 * 60 * 60; // 6 hours
const DEFAULT_STALE_WHILE_REVALIDATE_SECONDS = 7 * 24 * 60 * 60; // 7 days

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

function parseMonth(monthStr) {
  const m = /^(\d{4})-(\d{2})$/.exec(monthStr);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return { year, month };
}

function toMonthStr({ year, month }) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function monthIndex({ year, month }) {
  return year * 12 + (month - 1);
}

function addMonths(monthObj, deltaMonths) {
  const idx = monthIndex(monthObj) + deltaMonths;
  const year = Math.floor(idx / 12);
  const month = (idx % 12) + 1;
  return { year, month };
}

function monthStartDateUtc(monthObj) {
  return new Date(Date.UTC(monthObj.year, monthObj.month - 1, 1));
}

function listMonthsInclusive(startMonthObj, endMonthObj) {
  const out = [];
  for (let idx = monthIndex(startMonthObj); idx <= monthIndex(endMonthObj); idx += 1) {
    const year = Math.floor(idx / 12);
    const month = (idx % 12) + 1;
    out.push({ year, month });
  }
  return out;
}

async function fetchBundesbankJson(startPeriod, endPeriod) {
  // Prefer a bounded request; fall back to the unbounded series if the API rejects params.
  const urlWithRange = `${BASE_URL}?${new URLSearchParams({
    startPeriod,
    endPeriod,
  }).toString()}`;

  const tryFetch = async (url) => {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Netlify bond-monthly-flags)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Bundesbank request failed: ${res.status} ${res.statusText}`);
    return res.json();
  };

  try {
    return await tryFetch(urlWithRange);
  } catch {
    return tryFetch(BASE_URL);
  }
}

function parseBundSeries(json, startPeriod, endPeriod) {
  const obs = json?.data?.dataSets?.[0]?.series?.["0:0:0:0:0:0"]?.observations;
  if (!obs || typeof obs !== "object") {
    throw new Error("Bundesbank response missing observations");
  }

  const values = json?.data?.structure?.dimensions?.observation?.[0]?.values;
  if (!Array.isArray(values)) throw new Error("Bundesbank response missing observation values");

  const keys = Object.keys(obs)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  const out = [];
  for (const idx of keys) {
    const date = values[idx]?.id || values[idx]?.name || null;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (date < startPeriod || date > endPeriod) continue;

    const dateObj = parseISODate(date);
    if (!dateObj || !isWeekday(dateObj)) continue;

    const raw = obs[String(idx)]?.[0];
    const y = Math.round(Number(raw) * 100) / 100;
    if (!Number.isFinite(y)) continue;
    if (y === 0) continue; // non-trading placeholder

    out.push({ date, yield: y });
  }

  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const startMonthStr = typeof qs.startMonth === "string" ? qs.startMonth : DEFAULT_START_MONTH;
    const endMonthStr = typeof qs.endMonth === "string" ? qs.endMonth : DEFAULT_END_MONTH;

    const startMonth = parseMonth(startMonthStr);
    const endMonth = parseMonth(endMonthStr);
    if (!startMonth || !endMonth) throw new Error("Invalid startMonth/endMonth (expected YYYY-MM)");
    if (monthIndex(startMonth) > monthIndex(endMonth)) throw new Error("startMonth must be <= endMonth");

    const baselineMonth = addMonths(startMonth, -1);
    const afterEndMonth = addMonths(endMonth, 1);

    const startPeriod = `${toMonthStr(baselineMonth)}-01`;
    const endExclusive = monthStartDateUtc(afterEndMonth);
    const endPeriod = toISODate(addDays(endExclusive, -1));

    const fetchedAt = new Date().toISOString();
    const json = await fetchBundesbankJson(startPeriod, endPeriod);
    const points = parseBundSeries(json, startPeriod, endPeriod);
    if (!points.length) throw new Error("No yield points available for requested window");

    const months = listMonthsInclusive(startMonth, endMonth);
    const results = [];

    for (const monthObj of months) {
      const monthStr = toMonthStr(monthObj);
      const monthStart = `${monthStr}-01`;
      const nextMonthStart = `${toMonthStr(addMonths(monthObj, 1))}-01`;

      let baselinePoint = null;
      for (const p of points) {
        if (p.date < monthStart) baselinePoint = p;
        else break;
      }
      if (!baselinePoint) {
        results.push({
          month: monthStr,
          status: "UNKNOWN",
          reason: "missing_baseline",
        });
        continue;
      }

      const monthPoints = points.filter((p) => p.date >= monthStart && p.date < nextMonthStart);
      if (!monthPoints.length) {
        results.push({
          month: monthStr,
          baselineDate: baselinePoint.date,
          baselineYield: baselinePoint.yield,
          status: "UNKNOWN",
          reason: "missing_month_data",
        });
        continue;
      }

      const baselineYield = baselinePoint.yield;
      const upperTrigger = Math.round((baselineYield + THRESHOLD_BP / 100) * 100) / 100;
      const lowerTrigger = Math.round((baselineYield - THRESHOLD_BP / 100) * 100) / 100;

      let minYield = Infinity;
      let maxYield = -Infinity;
      for (const p of monthPoints) {
        if (p.yield < minYield) minYield = p.yield;
        if (p.yield > maxYield) maxYield = p.yield;
      }

      const breachedUpper = maxYield >= upperTrigger;
      const breachedLower = minYield <= lowerTrigger;
      const status = breachedUpper || breachedLower ? "YES" : "NO";
      const breach =
        breachedUpper && breachedLower ? "BOTH" : breachedUpper ? "UPPER" : breachedLower ? "LOWER" : null;

      results.push({
        month: monthStr,
        baselineDate: baselinePoint.date,
        baselineYield,
        upperTrigger,
        lowerTrigger,
        minYield,
        maxYield,
        breachedUpper,
        breachedLower,
        breach,
        status,
        points: monthPoints.length,
      });
    }

    const body = {
      seriesId: SERIES_ID,
      thresholdBp: THRESHOLD_BP,
      startMonth: startMonthStr,
      endMonth: endMonthStr,
      startPeriod,
      endPeriod,
      fetchedAt,
      lastUpdated: formatTimestampUtc(fetchedAt),
      months: results,
      source: {
        provider: "Deutsche Bundesbank",
        url: BASE_URL,
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
        error: "bond_monthly_flags_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};

