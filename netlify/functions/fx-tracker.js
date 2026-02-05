// Netlify Function: Live FX tracker data (Feb 2026) from Yahoo Finance "Close" prices.

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

const MONTH = "2026-02";
const MONTH_START = "2026-02-01";
const MONTH_END = "2026-02-28";
const BASELINE_DATE = "2026-01-30";

const DEFAULT_ROUND_DECIMALS = 4;
const DEFAULT_CDN_CACHE_SECONDS = 60 * 60; // 1 hour
const DEFAULT_STALE_WHILE_REVALIDATE_SECONDS = 24 * 60 * 60; // 1 day

function parseISODate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Basic validation (e.g. 2026-02-31 should fail).
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

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
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
  return d.toLocaleString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }) + " GMT";
}

async function fetchYahooDailyCloses(symbol, startInclusive, endExclusive, { roundDecimals }) {
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
      "User-Agent": "Mozilla/5.0 (Netlify fx-tracker)",
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

    let closeValue = Number(close);
    if (!Number.isFinite(closeValue)) continue;
    if (roundDecimals !== null) closeValue = roundTo(closeValue, roundDecimals);
    closeByDate[dateStr] = closeValue;
  }

  return closeByDate;
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const asofParam = typeof qs.asof === "string" ? qs.asof : null;
    const noRound = qs.noRound === "1" || qs.noRound === "true";

    const asOfLimitDate =
      (asofParam && parseISODate(asofParam)) || new Date(Date.now());
    const monthEnd = parseISODate(MONTH_END);
    if (!monthEnd) throw new Error("Internal date config error: MONTH_END");

    const asOfLimit = asOfLimitDate > monthEnd ? monthEnd : asOfLimitDate;
    const baselineDate = parseISODate(BASELINE_DATE);
    const fetchStart = addDays(baselineDate, -14);
    const fetchEndExclusive = addDays(asOfLimit, 1);

    const roundDecimals = noRound ? null : DEFAULT_ROUND_DECIMALS;

    const fetchedAt = new Date().toISOString();

    const entries = Object.entries(TICKERS);
    const closeMaps = await Promise.all(
      entries.map(async ([code, symbol]) => {
        const closeByDate = await fetchYahooDailyCloses(symbol, fetchStart, fetchEndExclusive, {
          roundDecimals,
        });
        return [code, { symbol, closeByDate }];
      })
    );

    const seriesByCode = Object.fromEntries(closeMaps);

    // Baseline closes
    const baseline = {};
    for (const code of Object.keys(TICKERS)) {
      const series = seriesByCode[code];
      const v = series?.closeByDate?.[BASELINE_DATE];
      if (v === undefined) {
        throw new Error(`Missing baseline close for ${code} on ${BASELINE_DATE}`);
      }
      baseline[code] = v;
    }

    // Determine as-of date: latest common weekday close in Feb 2026 up to asOfLimit.
    const monthStart = parseISODate(MONTH_START);
    const monthStartStr = MONTH_START;
    const asOfLimitStr = toISODate(asOfLimit);
    let candidates = null;

    for (const code of Object.keys(TICKERS)) {
      const dates = Object.keys(seriesByCode[code].closeByDate || {}).filter((d) => {
        return d >= monthStartStr && d <= MONTH_END && d <= asOfLimitStr;
      });
      const set = new Set(dates);
      candidates = candidates ? intersection(candidates, set) : set;
    }

    const commonDates = candidates && candidates.size ? Array.from(candidates).sort() : [];
    const asOfDate = commonDates.length ? commonDates.at(-1) : BASELINE_DATE;

    const current = {};
    const pct = {};
    const standings = [];
    for (const code of Object.keys(TICKERS)) {
      const currentClose = seriesByCode[code].closeByDate[asOfDate];
      if (currentClose === undefined) {
        throw new Error(`Missing as-of close for ${code} on ${asOfDate}`);
      }
      current[code] = currentClose;
      const base = baseline[code];
      const pctChange = ((currentClose - base) / base) * 100;
      pct[code] = pctChange;
      standings.push({
        code,
        ticker: TICKERS[code],
        baselineClose: base,
        asOfClose: currentClose,
        pctChange,
      });
    }
    standings.sort((a, b) => b.pctChange - a.pctChange);

    const seriesDates = [BASELINE_DATE, ...commonDates];
    const series = {
      dates: seriesDates,
      close: {},
      pct: {},
    };
    for (const code of Object.keys(TICKERS)) {
      const base = baseline[code];
      const closeArr = seriesDates.map((d) => seriesByCode[code].closeByDate[d] ?? null);
      const pctArr = closeArr.map((v, idx) => {
        if (v === null || v === undefined) return null;
        if (idx === 0) return 0;
        return ((v - base) / base) * 100;
      });
      series.close[code] = closeArr;
      series.pct[code] = pctArr;
    }

    const body = {
      month: MONTH,
      baselineDate: BASELINE_DATE,
      asOfDate,
      fetchedAt,
      lastUpdated: formatTimestampUtc(fetchedAt),
      baseline,
      current,
      pct,
      series,
      leader: standings[0] ? { code: standings[0].code, pctChange: standings[0].pctChange } : null,
      tickers: TICKERS,
      standings,
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
        error: "fx_tracker_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
