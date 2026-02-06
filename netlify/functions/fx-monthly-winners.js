// Netlify Function: Monthly FX "winner" (largest % rise vs USD) using Yahoo Finance "Close" prices.
//
// Default window: 2025-01 through 2026-01 (inclusive), as requested.

const TICKERS = {
  EUR: "EURUSD=X",
  JPY: "JPYUSD=X",
  GBP: "GBPUSD=X",
  CNY: "CNYUSD=X",
  CHF: "CHFUSD=X",
  AUD: "AUDUSD=X",
  CAD: "CADUSD=X",
  MXN: "MXNUSD=X",
};

const DEFAULT_START_MONTH = "2025-01";
const DEFAULT_END_MONTH = "2026-01";

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

function intersection(a, b) {
  const out = new Set();
  for (const v of a) {
    if (b.has(v)) out.add(v);
  }
  return out;
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

async function fetchYahooDailyCloses(symbol, startInclusive, endExclusive) {
  const period1 = Math.floor(startInclusive.getTime() / 1000);
  const period2 = Math.floor(endExclusive.getTime() / 1000);

  const params = new URLSearchParams({
    period1: String(period1),
    period2: String(period2),
    interval: "1d",
    events: "history",
    includeAdjustedClose: "true",
  });

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Netlify fx-monthly-winners)",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    throw new Error(`Yahoo request failed for ${symbol}: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();

  const chart = json?.chart;
  if (!chart) throw new Error(`Yahoo response missing chart for ${symbol}`);
  if (chart.error) throw new Error(`Yahoo chart error for ${symbol}: ${JSON.stringify(chart.error)}`);

  const result = (chart.result && chart.result[0]) || null;
  if (!result) throw new Error(`Yahoo response missing result for ${symbol}`);

  const timestamps = result.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) {
    throw new Error(`Yahoo response missing timestamp/close arrays for ${symbol}`);
  }

  const closeByDate = {};
  for (let i = 0; i < Math.min(timestamps.length, closes.length); i += 1) {
    const ts = timestamps[i];
    const close = closes[i];
    if (close === null || close === undefined) continue;
    const dateStr = new Date(ts * 1000).toISOString().slice(0, 10);
    const dateObj = parseISODate(dateStr);
    if (!dateObj || !isWeekday(dateObj)) continue;

    const closeValue = Number(close);
    if (!Number.isFinite(closeValue)) continue;
    closeByDate[dateStr] = closeValue;
  }

  return closeByDate;
}

function lastDateBeforeOrEqual(sortedDates, upperExclusive) {
  let last = null;
  for (const d of sortedDates) {
    if (d < upperExclusive) last = d;
    else break;
  }
  return last;
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

    const fetchStart = monthStartDateUtc(baselineMonth);
    // Small buffer past the last month boundary helps with timestamp/timezone edge cases.
    const fetchEndExclusive = addDays(monthStartDateUtc(afterEndMonth), 7);

    const fetchedAt = new Date().toISOString();

    const entries = Object.entries(TICKERS);
    const closeMaps = await Promise.all(
      entries.map(async ([code, symbol]) => {
        const closeByDate = await fetchYahooDailyCloses(symbol, fetchStart, fetchEndExclusive);
        return [code, { symbol, closeByDate }];
      })
    );
    const seriesByCode = Object.fromEntries(closeMaps);

    // Determine common weekday dates across all currencies.
    let candidates = null;
    for (const code of Object.keys(TICKERS)) {
      const dates = Object.keys(seriesByCode[code].closeByDate || {});
      const set = new Set(dates);
      candidates = candidates ? intersection(candidates, set) : set;
    }
    const commonDates = candidates && candidates.size ? Array.from(candidates).sort() : [];
    if (!commonDates.length) throw new Error("No common dates found across currencies");

    const months = listMonthsInclusive(startMonth, endMonth);
    const results = [];

    for (const monthObj of months) {
      const monthStr = toMonthStr(monthObj);
      const monthStart = `${monthStr}-01`;
      const nextMonthStart = `${toMonthStr(addMonths(monthObj, 1))}-01`;

      const baselineDate = lastDateBeforeOrEqual(commonDates, monthStart);
      const asOfDate = lastDateBeforeOrEqual(commonDates, nextMonthStart);
      if (!baselineDate || !asOfDate || asOfDate < monthStart) {
        results.push({
          month: monthStr,
          status: "UNKNOWN",
          baselineDate: baselineDate || null,
          asOfDate: asOfDate || null,
        });
        continue;
      }

      const changes = {};
      for (const code of Object.keys(TICKERS)) {
        const base = seriesByCode[code]?.closeByDate?.[baselineDate];
        const end = seriesByCode[code]?.closeByDate?.[asOfDate];
        if (!Number.isFinite(base) || !Number.isFinite(end) || base === 0) {
          changes[code] = null;
          continue;
        }
        changes[code] = ((end - base) / base) * 100;
      }

      let winnerCode = null;
      let winnerPct = -Infinity;
      for (const code of Object.keys(TICKERS)) {
        const v = changes[code];
        if (!Number.isFinite(v)) continue;
        if (v > winnerPct) {
          winnerPct = v;
          winnerCode = code;
        }
      }

      results.push({
        month: monthStr,
        baselineDate,
        asOfDate,
        winner: winnerCode ? { code: winnerCode, pctChange: winnerPct } : null,
        changes,
        status: winnerCode ? "OK" : "UNKNOWN",
      });
    }

    const body = {
      startMonth: startMonthStr,
      endMonth: endMonthStr,
      fetchedAt,
      lastUpdated: formatTimestampUtc(fetchedAt),
      tickers: TICKERS,
      months: results,
      source: {
        provider: "Yahoo Finance",
        method: "chart",
        note: 'Uses daily "close" values from https://query1.finance.yahoo.com/v8/finance/chart/…',
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
        error: "fx_monthly_winners_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};

