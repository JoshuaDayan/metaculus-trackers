// Netlify Function: Calibrated Brent/WTI spot estimates.
// Ground truth: EIA spot (RBRTE, RWTC). Live input: Yahoo Finance futures (BZ=F, CL=F).
//
// Metaculus question: Brent - WTI spot on 2026-03-04 (EIA).
// https://www.metaculus.com/questions/41689/brent-minus-wti-on-mar-4-2026/

const EIA_ENDPOINT = "https://api.eia.gov/v2/petroleum/pri/spt/data/";
const EIA_SERIES_WTI = "RWTC"; // WTI - Cushing, Oklahoma
const EIA_SERIES_BRENT = "RBRTE"; // Brent - Europe

const YAHOO_SYMBOL_WTI = "CL=F";
const YAHOO_SYMBOL_BRENT = "BZ=F";

const TARGET_DATE = "2026-03-04";
const INTERPOLATION_DEADLINE = "2026-03-14";

const BASIS_HALF_LIFE_BUSINESS_DAYS = 3;
const BASIS_LAMBDA = Math.pow(0.5, 1 / BASIS_HALF_LIFE_BUSINESS_DAYS); // ~0.794
const BASIS_ALPHA = 1 - BASIS_LAMBDA; // ~0.206

const EIA_FETCH_LENGTH = 200;
const RAW_BASIS_WINDOW_DAYS = 10;
const DAILY_FETCH_LOOKBACK_DAYS = 240;

const INTRADAY_INTERVAL = "5m";
const INTRADAY_RANGE_DAYS = 5;

const DEFAULT_CDN_CACHE_SECONDS = 10 * 60; // 10 minutes
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

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
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

function businessDaysBetween(startDateStr, endDateStr) {
  const start = parseISODate(startDateStr);
  const end = parseISODate(endDateStr);
  if (!start || !end) return null;
  if (end < start) return 0;
  let count = 0;
  // Count weekdays from the day after start through end inclusive.
  let cur = addDays(start, 1);
  while (cur <= end) {
    if (isWeekday(cur)) count += 1;
    cur = addDays(cur, 1);
  }
  return count;
}

async function fetchEiaSpot({ apiKey, length }) {
  const params = new URLSearchParams();
  params.set("api_key", apiKey);
  params.set("frequency", "daily");
  params.set("data[0]", "value");
  params.append("facets[series][]", EIA_SERIES_WTI);
  params.append("facets[series][]", EIA_SERIES_BRENT);
  params.set("sort[0][column]", "period");
  params.set("sort[0][direction]", "desc");
  params.set("length", String(length));

  const url = `${EIA_ENDPOINT}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Netlify oil-calibrated)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`EIA request failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const rows = json?.response?.data;
  if (!Array.isArray(rows)) throw new Error("EIA response missing response.data array");

  const bySeries = {
    [EIA_SERIES_WTI]: {},
    [EIA_SERIES_BRENT]: {},
  };

  for (const row of rows) {
    const series = row?.series;
    const period = row?.period;
    const value = row?.value;
    if (series !== EIA_SERIES_WTI && series !== EIA_SERIES_BRENT) continue;
    if (typeof period !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(period)) continue;
    const dateObj = parseISODate(period);
    if (!dateObj || !isWeekday(dateObj)) continue;
    const v = round2(value);
    if (!Number.isFinite(v)) continue;
    bySeries[series][period] = v;
  }

  return { bySeries };
}

async function fetchYahooChart(symbol, params) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?${params.toString()}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": `Mozilla/5.0 (Netlify oil-calibrated; ${symbol})` },
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

  return result;
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

  const result = await fetchYahooChart(symbol, params);

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

    const v = round2(close);
    if (!Number.isFinite(v)) continue;
    closeByDate[dateStr] = v;
  }

  const meta = result.meta || {};
  const livePrice = round2(meta?.regularMarketPrice);
  const liveTimeSec = Number(meta?.regularMarketTime);
  const liveTimestamp = Number.isFinite(liveTimeSec)
    ? new Date(liveTimeSec * 1000).toISOString()
    : null;

  return {
    closeByDate,
    live: {
      price: Number.isFinite(livePrice) ? livePrice : null,
      timestamp: liveTimestamp,
    },
  };
}

async function fetchYahooIntraday(symbol, { days, interval }) {
  const params = new URLSearchParams({
    interval,
    range: `${days}d`,
    includePrePost: "false",
  });

  const result = await fetchYahooChart(symbol, params);
  const timestamps = result.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) {
    throw new Error(`Yahoo intraday response missing timestamp/close arrays for ${symbol}`);
  }

  const byTs = new Map();
  for (let i = 0; i < Math.min(timestamps.length, closes.length); i += 1) {
    const ts = Number(timestamps[i]);
    const close = closes[i];
    if (!Number.isFinite(ts) || close === null || close === undefined) continue;
    const v = round2(close);
    if (!Number.isFinite(v)) continue;
    byTs.set(ts, v);
  }

  const meta = result.meta || {};
  const livePrice = round2(meta?.regularMarketPrice);
  const liveTimeSec = Number(meta?.regularMarketTime);
  const liveTimestamp = Number.isFinite(liveTimeSec)
    ? new Date(liveTimeSec * 1000).toISOString()
    : null;

  return {
    byTs,
    live: {
      price: Number.isFinite(livePrice) ? livePrice : null,
      timestamp: liveTimestamp,
    },
  };
}

function computeSmoothedBasis(rawBasisPointsAsc) {
  const n = rawBasisPointsAsc.length;
  if (n === 0) return { smoothed: null, method: "none" };
  if (n < 3) {
    const mean = rawBasisPointsAsc.reduce((a, p) => a + p.value, 0) / n;
    return { smoothed: mean, method: "mean_cold_start" };
  }

  const initMean =
    (rawBasisPointsAsc[0].value + rawBasisPointsAsc[1].value + rawBasisPointsAsc[2].value) / 3;
  let smoothed = initMean;
  for (let i = 3; i < n; i += 1) {
    smoothed = BASIS_ALPHA * rawBasisPointsAsc[i].value + BASIS_LAMBDA * smoothed;
  }

  return { smoothed, method: "ewma_half_life_3bd" };
}

function lastCommonDate(mapA, mapB) {
  const aDates = Object.keys(mapA || {});
  const bDates = new Set(Object.keys(mapB || {}));
  const common = aDates.filter((d) => bDates.has(d)).sort();
  return common.length ? common.at(-1) : null;
}

function computeResolution({ eiaWtiByDate, eiaBrentByDate, nowDateStr }) {
  const targetWti = eiaWtiByDate?.[TARGET_DATE];
  const targetBrent = eiaBrentByDate?.[TARGET_DATE];

  const canExact = Number.isFinite(targetWti) && Number.isFinite(targetBrent);
  if (canExact) {
    return {
      status: "exact",
      targetDate: TARGET_DATE,
      value: round2(targetBrent - targetWti),
      legs: { brent: targetBrent, wti: targetWti },
    };
  }

  // Only interpolate after the Metaculus deadline.
  if (nowDateStr < INTERPOLATION_DEADLINE) {
    return {
      status: "pending",
      targetDate: TARGET_DATE,
      deadline: INTERPOLATION_DEADLINE,
      reason: "EIA has not published both spot prices for the target date yet.",
    };
  }

  const commonDates = Object.keys(eiaWtiByDate || {})
    .filter((d) => Number.isFinite(eiaWtiByDate[d]) && Number.isFinite(eiaBrentByDate?.[d]))
    .sort();

  const prev = commonDates.filter((d) => d < TARGET_DATE).at(-1) || null;
  const next = commonDates.find((d) => d > TARGET_DATE) || null;
  if (!prev || !next) {
    return {
      status: "unavailable",
      targetDate: TARGET_DATE,
      deadline: INTERPOLATION_DEADLINE,
      reason: "Insufficient EIA data to interpolate (need dates on both sides of target).",
    };
  }

  const prevDate = parseISODate(prev);
  const nextDate = parseISODate(next);
  const tgtDate = parseISODate(TARGET_DATE);
  if (!prevDate || !nextDate || !tgtDate) {
    return {
      status: "unavailable",
      targetDate: TARGET_DATE,
      deadline: INTERPOLATION_DEADLINE,
      reason: "Internal date parse failure.",
    };
  }

  const t = (tgtDate.getTime() - prevDate.getTime()) / (nextDate.getTime() - prevDate.getTime());
  const wti = eiaWtiByDate[prev] + t * (eiaWtiByDate[next] - eiaWtiByDate[prev]);
  const brent = eiaBrentByDate[prev] + t * (eiaBrentByDate[next] - eiaBrentByDate[prev]);

  return {
    status: "interpolated",
    targetDate: TARGET_DATE,
    deadline: INTERPOLATION_DEADLINE,
    value: round2(brent - wti),
    interpolation: {
      prevDate: prev,
      nextDate: next,
      t,
      wti: round2(wti),
      brent: round2(brent),
    },
  };
}

exports.handler = async () => {
  try {
    const apiKey = process.env.EIA_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        body: JSON.stringify({
          error: "missing_eia_api_key",
          message: "Missing EIA_API_KEY environment variable.",
        }),
      };
    }

    const fetchedAt = new Date().toISOString();
    const nowDateStr = toISODate(new Date());

    const eia = await fetchEiaSpot({ apiKey, length: EIA_FETCH_LENGTH });
    const eiaWtiByDate = eia.bySeries[EIA_SERIES_WTI] || {};
    const eiaBrentByDate = eia.bySeries[EIA_SERIES_BRENT] || {};

    const endExclusive = addDays(new Date(), 1);
    const startInclusive = addDays(endExclusive, -DAILY_FETCH_LOOKBACK_DAYS);

    const [wtiDaily, brentDaily] = await Promise.all([
      fetchYahooDailyCloses(YAHOO_SYMBOL_WTI, startInclusive, endExclusive),
      fetchYahooDailyCloses(YAHOO_SYMBOL_BRENT, startInclusive, endExclusive),
    ]);

    // Raw basis window: last N common EIA dates where we also have the futures close.
    const commonEiaDates = Object.keys(eiaWtiByDate)
      .filter((d) => Number.isFinite(eiaWtiByDate[d]) && Number.isFinite(eiaBrentByDate?.[d]))
      .sort();

    const basisDates = commonEiaDates
      .filter((d) => Number.isFinite(wtiDaily.closeByDate?.[d]) && Number.isFinite(brentDaily.closeByDate?.[d]))
      .slice(-RAW_BASIS_WINDOW_DAYS);

    const rawBasisWtiAsc = [];
    const rawBasisBrentAsc = [];
    for (const date of basisDates) {
      rawBasisWtiAsc.push({
        date,
        value: eiaWtiByDate[date] - wtiDaily.closeByDate[date],
        eiaSpot: eiaWtiByDate[date],
        futuresSettle: wtiDaily.closeByDate[date],
      });
      rawBasisBrentAsc.push({
        date,
        value: eiaBrentByDate[date] - brentDaily.closeByDate[date],
        eiaSpot: eiaBrentByDate[date],
        futuresSettle: brentDaily.closeByDate[date],
      });
    }

    const smWti = computeSmoothedBasis(rawBasisWtiAsc);
    const smBrent = computeSmoothedBasis(rawBasisBrentAsc);

    const smoothedBasisWti = smWti.smoothed;
    const smoothedBasisBrent = smBrent.smoothed;

    const liveFuturesWti = wtiDaily.live.price;
    const liveFuturesBrent = brentDaily.live.price;

    if (!Number.isFinite(liveFuturesWti) || !Number.isFinite(liveFuturesBrent)) {
      throw new Error("Yahoo live futures prices unavailable");
    }
    if (!Number.isFinite(smoothedBasisWti) || !Number.isFinite(smoothedBasisBrent)) {
      throw new Error("Insufficient basis data to calibrate (need at least 1 aligned EIA+futures close)");
    }

    const calibratedWti = liveFuturesWti + smoothedBasisWti;
    const calibratedBrent = liveFuturesBrent + smoothedBasisBrent;

    const latestEiaDateWti = Object.keys(eiaWtiByDate).sort().at(-1) || null;
    const latestEiaDateBrent = Object.keys(eiaBrentByDate).sort().at(-1) || null;
    const latestEiaCommon = lastCommonDate(eiaWtiByDate, eiaBrentByDate);
    const latestEiaSpread =
      latestEiaCommon && Number.isFinite(eiaWtiByDate[latestEiaCommon]) && Number.isFinite(eiaBrentByDate[latestEiaCommon])
        ? eiaBrentByDate[latestEiaCommon] - eiaWtiByDate[latestEiaCommon]
        : null;

    const mostRecentBasisDate = basisDates.length ? basisDates.at(-1) : null;
    const basisAgeDays = mostRecentBasisDate ? businessDaysBetween(mostRecentBasisDate, nowDateStr) : null;

    const basisSpread = smoothedBasisBrent - smoothedBasisWti;

    const now = new Date();
    const yearStartStr = `${now.getUTCFullYear()}-01-01`;
    const periodStartStr = `${nowDateStr.slice(0, 7)}-01`;

    const dailyCommonDates = Object.keys(wtiDaily.closeByDate || {})
      .filter((d) => Number.isFinite(wtiDaily.closeByDate[d]) && Number.isFinite(brentDaily.closeByDate?.[d]))
      .filter((d) => d >= yearStartStr)
      .sort();

    const dailyHistory = {
      dates: [],
      futures_spread: [],
      calibrated_spread: [],
      eia_spread: [],
    };

    for (const date of dailyCommonDates) {
      const wClose = wtiDaily.closeByDate[date];
      const bClose = brentDaily.closeByDate[date];
      if (!Number.isFinite(wClose) || !Number.isFinite(bClose)) continue;

      const fSpread = bClose - wClose;
      const eiaW = eiaWtiByDate?.[date];
      const eiaB = eiaBrentByDate?.[date];
      const eiaSpread = Number.isFinite(eiaW) && Number.isFinite(eiaB) ? eiaB - eiaW : null;

      dailyHistory.dates.push(date);
      dailyHistory.futures_spread.push(round2(fSpread));
      dailyHistory.calibrated_spread.push(round2(fSpread + basisSpread));
      dailyHistory.eia_spread.push(Number.isFinite(eiaSpread) ? round2(eiaSpread) : null);
    }

    // Intraday series (best-effort) for charts. If Yahoo rejects intraday ranges/intervals, still
    // return the point-in-time calibrated values (page stays up).
    const intraday = {
      available: false,
      interval: INTRADAY_INTERVAL,
      rangeDays: INTRADAY_RANGE_DAYS,
      timestamps: [],
      futures: { wti: [], brent: [] },
      calibrated: { wti: [], brent: [], spread: [] },
    };
    try {
      const [wtiIntra, brentIntra] = await Promise.all([
        fetchYahooIntraday(YAHOO_SYMBOL_WTI, { days: INTRADAY_RANGE_DAYS, interval: INTRADAY_INTERVAL }),
        fetchYahooIntraday(YAHOO_SYMBOL_BRENT, { days: INTRADAY_RANGE_DAYS, interval: INTRADAY_INTERVAL }),
      ]);

      const commonTs = Array.from(wtiIntra.byTs.keys())
        .filter((ts) => brentIntra.byTs.has(ts))
        .sort((a, b) => a - b);

      for (const ts of commonTs) {
        const w = wtiIntra.byTs.get(ts);
        const b = brentIntra.byTs.get(ts);
        if (!Number.isFinite(w) || !Number.isFinite(b)) continue;

        intraday.timestamps.push(new Date(ts * 1000).toISOString());
        intraday.futures.wti.push(w);
        intraday.futures.brent.push(b);

        intraday.calibrated.wti.push(round2(w + smoothedBasisWti));
        intraday.calibrated.brent.push(round2(b + smoothedBasisBrent));
        intraday.calibrated.spread.push(round2((b - w) + basisSpread));
      }
      intraday.available = intraday.timestamps.length >= 2;
    } catch {
      intraday.available = false;
    }

    const liveTs = wtiDaily.live.timestamp || brentDaily.live.timestamp || fetchedAt;
    const isStale = (() => {
      const t = new Date(liveTs).getTime();
      if (!Number.isFinite(t)) return false;
      return Date.now() - t > 60 * 60 * 1000; // > 1 hour since last futures update
    })();

    const resolution = computeResolution({ eiaWtiByDate, eiaBrentByDate, nowDateStr });

    const body = {
      timestamp: fetchedAt,
      lastUpdated: formatTimestampUtc(fetchedAt),
      metaculus: {
        url: "https://www.metaculus.com/questions/41689/brent-minus-wti-on-mar-4-2026/",
        targetDate: TARGET_DATE,
        interpolationDeadline: INTERPOLATION_DEADLINE,
        resolution,
      },
      wti: {
        calibrated_spot: round2(calibratedWti),
        live_futures: round2(liveFuturesWti),
        live_futures_timestamp: wtiDaily.live.timestamp,
        smoothed_basis: round2(smoothedBasisWti),
        smoothed_basis_method: smWti.method,
        last_eia_spot: latestEiaDateWti ? eiaWtiByDate[latestEiaDateWti] : null,
        last_eia_date: latestEiaDateWti,
      },
      brent: {
        calibrated_spot: round2(calibratedBrent),
        live_futures: round2(liveFuturesBrent),
        live_futures_timestamp: brentDaily.live.timestamp,
        smoothed_basis: round2(smoothedBasisBrent),
        smoothed_basis_method: smBrent.method,
        last_eia_spot: latestEiaDateBrent ? eiaBrentByDate[latestEiaDateBrent] : null,
        last_eia_date: latestEiaDateBrent,
      },
      spread: {
        calibrated: round2(calibratedBrent - calibratedWti),
        live_futures: round2(liveFuturesBrent - liveFuturesWti),
        last_eia: Number.isFinite(latestEiaSpread) ? round2(latestEiaSpread) : null,
        last_eia_date: latestEiaCommon,
      },
      stale: isStale,
      basis_age_days: basisAgeDays,
      basis: {
        half_life_business_days: BASIS_HALF_LIFE_BUSINESS_DAYS,
        lambda: BASIS_LAMBDA,
        alpha: BASIS_ALPHA,
        window_days: RAW_BASIS_WINDOW_DAYS,
        raw: {
          wti: rawBasisWtiAsc.map((p) => ({ date: p.date, raw_basis: round2(p.value), eia_spot: p.eiaSpot, futures_settle: p.futuresSettle })),
          brent: rawBasisBrentAsc.map((p) => ({ date: p.date, raw_basis: round2(p.value), eia_spot: p.eiaSpot, futures_settle: p.futuresSettle })),
        },
      },
      history: {
        year_start: yearStartStr,
        period_start: periodStartStr,
        daily: dailyHistory,
      },
      intraday,
      source: {
        eia: {
          provider: "U.S. Energy Information Administration (EIA)",
          endpoint: EIA_ENDPOINT,
          series: {
            wti: EIA_SERIES_WTI,
            brent: EIA_SERIES_BRENT,
          },
        },
        futures: {
          provider: "Yahoo Finance",
          method: "chart",
          symbols: { wti: YAHOO_SYMBOL_WTI, brent: YAHOO_SYMBOL_BRENT },
        },
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
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify({
        error: "oil_calibrated_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
