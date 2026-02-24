// Netlify Function: Estimate IVV basket live-model error band using daily closes.
// Compares model-estimated basket weight (using prior holdings + price moves) vs next holdings snapshot.

const IVV_HOLDINGS_MODULE = require("./ivv-holdings-weight");

const DEFAULT_TICKERS = ["NVDA", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "AMD"];
const DEFAULT_START = "2026-02-01";
const DEFAULT_END = null; // use today (UTC)

const DEFAULT_CDN_CACHE_SECONDS = 10 * 60; // 10 minutes
const DEFAULT_STALE_WHILE_REVALIDATE_SECONDS = 60 * 60; // 1 hour
const DEFAULT_STALE_IF_ERROR_SECONDS = 24 * 60 * 60; // 1 day

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

function diffDays(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

async function fetchYahooDaily(symbol, startDate, endDate) {
  const period1 = Math.floor(startDate.getTime() / 1000);
  const period2 = Math.floor(addDays(endDate, 1).getTime() / 1000);
  const params = new URLSearchParams({
    period1: String(period1),
    period2: String(period2),
    interval: "1d",
    events: "history",
    includeAdjustedClose: "true",
  });
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": `Mozilla/5.0 (Netlify ivv-error-band; ${symbol})` },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    throw new Error(`Yahoo request failed for ${symbol}: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo response missing result for ${symbol}`);

  const timestamps = result.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const out = {};
  for (let i = 0; i < Math.min(timestamps.length, closes.length); i += 1) {
    const ts = timestamps[i];
    const close = closes[i];
    if (close === null || close === undefined) continue;
    const iso = new Date(ts * 1000).toISOString().slice(0, 10);
    out[iso] = Number(close);
  }
  return out;
}

function safeNumber(v) {
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

exports.handler = async (event = {}) => {
  try {
    const qs = event.queryStringParameters || {};
    const tickersParam = typeof qs.tickers === "string" ? qs.tickers : null;
    const tickers = (tickersParam ? tickersParam.split(",") : DEFAULT_TICKERS)
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    if (!tickers.length) throw new Error("No tickers provided");

    const startIso = typeof qs.start === "string" ? qs.start : DEFAULT_START;
    const endIso = typeof qs.end === "string" ? qs.end : DEFAULT_END;
    const startDate = parseISODate(startIso) || parseISODate(DEFAULT_START);
    const endDate = (endIso && parseISODate(endIso)) || new Date();
    if (!startDate) throw new Error("Invalid start date");

    const days = diffDays(startDate, endDate) + 1;
    const lookbackDays = Math.max(5, Math.min(730, days));

    const holdingsResp = await IVV_HOLDINGS_MODULE.handler({
      queryStringParameters: {
        days: String(lookbackDays),
        asof: toISODate(endDate),
        tickers: tickers.join(","),
      },
    });
    if (!holdingsResp || holdingsResp.statusCode !== 200) {
      throw new Error(`ivv-holdings-weight returned ${holdingsResp?.statusCode || "error"}`);
    }
    const holdingsData = JSON.parse(holdingsResp.body);
    const dates = holdingsData?.series?.dates || [];
    const total = holdingsData?.series?.total || [];
    const byTicker = holdingsData?.series?.byTicker || {};
    if (!Array.isArray(dates) || dates.length < 2) {
      throw new Error("Not enough holdings snapshots to compute error band");
    }

    const priceStart = addDays(startDate, -5);
    const priceEnd = endDate;
    const symbols = [...tickers, "IVV"];
    const priceBySymbol = {};
    await Promise.all(
      symbols.map(async (sym) => {
        priceBySymbol[sym] = await fetchYahooDaily(sym, priceStart, priceEnd);
      })
    );

    let minErr = null;
    let maxErr = null;
    let maxAbs = null;
    let minDate = null;
    let maxDate = null;
    let maxAbsDate = null;
    let count = 0;

    for (let i = 1; i < dates.length; i += 1) {
      const prev = dates[i - 1];
      const cur = dates[i];
      if (cur < startIso) continue;

      let ok = true;
      for (const t of symbols) {
        if (!(prev in priceBySymbol[t]) || !(cur in priceBySymbol[t])) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      const weightsPrev = {};
      let baseSum = 0;
      for (const t of tickers) {
        const w = safeNumber(byTicker?.[t]?.[i - 1]);
        if (w === null) {
          ok = false;
          break;
        }
        weightsPrev[t] = w;
        baseSum += w;
      }
      if (!ok) continue;

      const baseFrac = baseSum / 100;
      let basketVal = 0;
      for (const t of tickers) {
        basketVal += (weightsPrev[t] / 100) * (priceBySymbol[t][cur] / priceBySymbol[t][prev]);
      }
      const restVal = (1 - baseFrac) * (priceBySymbol.IVV[cur] / priceBySymbol.IVV[prev]);
      const denom = basketVal + restVal;
      if (!(denom > 0)) continue;
      const est = (basketVal / denom) * 100;
      const actual = safeNumber(total[i]);
      if (actual === null) continue;

      const err = est - actual;
      count += 1;

      if (minErr === null || err < minErr) {
        minErr = err;
        minDate = cur;
      }
      if (maxErr === null || err > maxErr) {
        maxErr = err;
        maxDate = cur;
      }
      const absErr = Math.abs(err);
      if (maxAbs === null || absErr > maxAbs) {
        maxAbs = absErr;
        maxAbsDate = cur;
      }
    }

    if (count === 0) throw new Error("No comparable dates with full price data");

    const body = {
      start: startIso,
      end: toISODate(endDate),
      count,
      min_error_pp: Number(minErr.toFixed(4)),
      min_error_date: minDate,
      max_error_pp: Number(maxErr.toFixed(4)),
      max_error_date: maxDate,
      max_abs_error_pp: Number(maxAbs.toFixed(4)),
      max_abs_error_date: maxAbsDate,
      method: {
        description:
          "Uses previous holdings snapshot and daily close price moves to estimate basket weight; compares to next official holdings snapshot.",
      },
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=0, must-revalidate",
        "Netlify-CDN-Cache-Control": `public, max-age=${DEFAULT_CDN_CACHE_SECONDS}, stale-while-revalidate=${DEFAULT_STALE_WHILE_REVALIDATE_SECONDS}, stale-if-error=${DEFAULT_STALE_IF_ERROR_SECONDS}`,
      },
      body: JSON.stringify(body),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify({
        error: "ivv_error_band_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
