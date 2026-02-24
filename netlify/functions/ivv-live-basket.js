// Netlify Function: Live IVV basket weight estimate using iShares weights + Yahoo intraday prices.
// This estimates intraday basket weight assuming the rest of the fund moves with IVV.

const IVV_HOLDINGS_CSV_URL_TEMPLATE =
  "https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf/" +
  "1467271812596.ajax?fileType=csv&fileName=IVV_holdings&dataType=fund&asOfDate={asOfDate}";

const DEFAULT_BASKET_TICKERS = ["NVDA", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "AMD"];
const YAHOO_SYMBOL_IVV = "IVV";

const INTRADAY_INTERVAL = "5m";
const INTRADAY_RANGE = "5d";
const INCLUDE_PRE_POST = true;

const HOLDINGS_LOOKBACK_DAYS = 10;

const DEFAULT_CDN_CACHE_SECONDS = 60; // 1 minute
const DEFAULT_STALE_WHILE_REVALIDATE_SECONDS = 10 * 60; // 10 minutes
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

function isWeekday(date) {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

function toAsOfDateParam(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function parseCsvRow(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    if (ch === "\r") continue;
    cur += ch;
  }
  out.push(cur);
  return out;
}

function extractFundHoldingsAsOfLabel(csvText) {
  const lines = csvText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/^\uFEFF/, "").trim();
    if (!line.startsWith("Fund Holdings as of")) continue;
    const cells = parseCsvRow(line);
    const label = (cells[1] || "").trim();
    if (!label || label === "-") return null;
    return label;
  }
  return null;
}

function parseHoldingsCsvForBasket(csvText, { basketTickers }) {
  const holdingsAsOfLabel = extractFundHoldingsAsOfLabel(csvText);
  if (!holdingsAsOfLabel) {
    return { available: false, holdingsAsOfLabel: null, weightByTicker: null, totalWeight: null };
  }

  const lines = csvText.split(/\r?\n/);
  let header = null;
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/^\uFEFF/, "");
    if (line.startsWith("Ticker,")) {
      header = parseCsvRow(line);
      headerIdx = i;
      break;
    }
  }
  if (!header || headerIdx < 0) {
    throw new Error('Holdings CSV missing header row starting with "Ticker,"');
  }

  const tickerCol = header.indexOf("Ticker");
  const weightCol = header.indexOf("Weight (%)");
  if (tickerCol < 0) throw new Error("Holdings CSV header missing Ticker column");
  if (weightCol < 0) throw new Error('Holdings CSV header missing "Weight (%)" column');

  const wanted = new Set(basketTickers.map((t) => t.toUpperCase()));
  const weightByTicker = {};

  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.replace(/^\uFEFF/, "");
    if (!line.trim()) continue;
    if (line.startsWith('"The content contained herein')) break;

    const row = parseCsvRow(line);
    const ticker = (row[tickerCol] || "").trim().toUpperCase();
    if (!ticker) continue;
    if (!wanted.has(ticker)) continue;

    const weightStr = (row[weightCol] || "").trim();
    const parsed = Number(weightStr.replace(/,/g, "").replace(/%/g, ""));
    if (!Number.isFinite(parsed)) continue;
    const weight = roundTo(parsed, 6);
    weightByTicker[ticker] = roundTo((weightByTicker[ticker] || 0) + weight, 6);
  }

  const missingTickers = basketTickers.filter((t) => weightByTicker[t.toUpperCase()] === undefined);
  if (missingTickers.length === basketTickers.length) {
    return { available: false, holdingsAsOfLabel, weightByTicker: null, totalWeight: null };
  }
  for (const t of missingTickers) {
    weightByTicker[t.toUpperCase()] = 0;
  }

  const totalWeight = roundTo(
    basketTickers.reduce((sum, t) => sum + (weightByTicker[t.toUpperCase()] || 0), 0),
    6
  );
  return { available: true, holdingsAsOfLabel, weightByTicker, totalWeight, missingTickers };
}

async function fetchHoldingsCsvText(asOfDateParam) {
  const url = IVV_HOLDINGS_CSV_URL_TEMPLATE.replace("{asOfDate}", encodeURIComponent(asOfDateParam));
  const res = await fetch(url, {
    headers: {
      Accept: "text/csv,*/*;q=0.9",
      "User-Agent": "Mozilla/5.0 (Netlify ivv-live-basket)",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    throw new Error(`iShares request failed: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

async function fetchLatestHoldingsSnapshot(basketTickers) {
  const today = new Date();
  for (let i = 0; i <= HOLDINGS_LOOKBACK_DAYS; i += 1) {
    const date = addDays(today, -i);
    if (!isWeekday(date)) continue;
    const asOfParam = toAsOfDateParam(date);
    try {
      const csvText = await fetchHoldingsCsvText(asOfParam);
      const parsed = parseHoldingsCsvForBasket(csvText, { basketTickers });
      if (!parsed.available) continue;
      return {
        asOfDate: toISODate(date),
        holdingsAsOfLabel: parsed.holdingsAsOfLabel,
        weightByTicker: parsed.weightByTicker,
        totalWeight: parsed.totalWeight,
        missingTickers: parsed.missingTickers || [],
      };
    } catch {
      continue;
    }
  }
  throw new Error("No recent IVV holdings snapshot found");
}

async function fetchYahooChart(symbol, params) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": `Mozilla/5.0 (Netlify ivv-live-basket; ${symbol})` },
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

async function fetchYahooIntradaySeries(symbol, { interval, range, includePrePost }) {
  const params = new URLSearchParams({
    interval,
    range,
    includePrePost: includePrePost ? "true" : "false",
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
    const v = roundTo(close, 6);
    if (!Number.isFinite(v)) continue;
    byTs.set(ts, v);
  }

  return { byTs, timestamps };
}

function computeBasketWeightSeries({ tickers, weightsByTicker, ivvSeries, tickerSeries }) {
  const ivvTs = ivvSeries.timestamps || [];
  const commonTs = [];
  for (const ts of ivvTs) {
    const t = Number(ts);
    if (!Number.isFinite(t)) continue;
    if (!ivvSeries.byTs.has(t)) continue;
    let ok = true;
    for (const ticker of tickers) {
      if (!tickerSeries[ticker].byTs.has(t)) {
        ok = false;
        break;
      }
    }
    if (ok) commonTs.push(t);
  }

  if (commonTs.length < 2) {
    throw new Error("Not enough common intraday points to compute live basket weight");
  }

  const baseTs = commonTs[0];
  const basePrices = {};
  for (const ticker of tickers) {
    const p = tickerSeries[ticker].byTs.get(baseTs);
    if (!Number.isFinite(p)) throw new Error(`Missing baseline price for ${ticker}`);
    basePrices[ticker] = p;
  }
  const ivvBase = ivvSeries.byTs.get(baseTs);
  if (!Number.isFinite(ivvBase)) throw new Error("Missing baseline price for IVV");

  const weightsFrac = {};
  let basketBaseWeight = 0;
  for (const t of tickers) {
    const w = Number(weightsByTicker[t.toUpperCase()] ?? 0) / 100;
    weightsFrac[t] = w;
    basketBaseWeight += w;
  }
  const restBaseWeight = Math.max(0, 1 - basketBaseWeight);

  const basketWeights = [];
  const timestampsIso = [];
  for (const ts of commonTs) {
    let basketVal = 0;
    for (const ticker of tickers) {
      const pNow = tickerSeries[ticker].byTs.get(ts);
      basketVal += weightsFrac[ticker] * (pNow / basePrices[ticker]);
    }
    const ivvNow = ivvSeries.byTs.get(ts);
    const restVal = restBaseWeight * (ivvNow / ivvBase);
    const denom = basketVal + restVal;
    const weightPct = denom > 0 ? (basketVal / denom) * 100 : null;
    basketWeights.push(weightPct !== null ? roundTo(weightPct, 4) : null);
    timestampsIso.push(new Date(ts * 1000).toISOString());
  }

  const latestIdx = basketWeights.length - 1;
  return {
    timestamps: timestampsIso,
    basketWeight: basketWeights,
    baselineTimestamp: new Date(baseTs * 1000).toISOString(),
    latest: {
      timestamp: timestampsIso[latestIdx],
      weight: basketWeights[latestIdx],
    },
    basketBaseWeightPct: roundTo(basketBaseWeight * 100, 4),
  };
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

exports.handler = async (event) => {
  try {
    const fetchedAt = new Date().toISOString();
    const qs = event.queryStringParameters || {};

    const tickersParam = typeof qs.tickers === "string" ? qs.tickers : null;
    const basketTickers = (tickersParam ? tickersParam.split(",") : DEFAULT_BASKET_TICKERS)
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    if (!basketTickers.length) throw new Error("No tickers provided");

    const holdings = await fetchLatestHoldingsSnapshot(basketTickers);

    const tickersToFetch = [...basketTickers, YAHOO_SYMBOL_IVV];
    const intradaySeries = await Promise.all(
      tickersToFetch.map((t) =>
        fetchYahooIntradaySeries(t, {
          interval: INTRADAY_INTERVAL,
          range: INTRADAY_RANGE,
          includePrePost: INCLUDE_PRE_POST,
        })
      )
    );

    const tickerSeries = {};
    for (let i = 0; i < basketTickers.length; i += 1) {
      tickerSeries[basketTickers[i]] = intradaySeries[i];
    }
    const ivvSeries = intradaySeries[intradaySeries.length - 1];

    const liveSeries = computeBasketWeightSeries({
      tickers: basketTickers,
      weightsByTicker: holdings.weightByTicker,
      ivvSeries,
      tickerSeries,
    });

    const body = {
      fetchedAt,
      lastUpdated: formatTimestampUtc(fetchedAt),
      basket: {
        tickers: basketTickers,
        asOfDate: holdings.asOfDate,
        holdingsAsOfLabel: holdings.holdingsAsOfLabel,
        weights: holdings.weightByTicker,
        totalWeight: holdings.totalWeight,
        missingTickers: holdings.missingTickers || [],
      },
      live: {
        interval: INTRADAY_INTERVAL,
        range: INTRADAY_RANGE,
        includePrePost: INCLUDE_PRE_POST,
        baselineTimestamp: liveSeries.baselineTimestamp,
        basketBaseWeightPct: liveSeries.basketBaseWeightPct,
        timestamps: liveSeries.timestamps,
        basketWeight: liveSeries.basketWeight,
        latest: liveSeries.latest,
      },
      source: {
        holdings: {
          provider: "iShares / BlackRock",
          urlTemplate: IVV_HOLDINGS_CSV_URL_TEMPLATE,
        },
        prices: {
          provider: "Yahoo Finance",
          symbols: { ivv: YAHOO_SYMBOL_IVV, basket: basketTickers },
          interval: INTRADAY_INTERVAL,
          range: INTRADAY_RANGE,
          includePrePost: INCLUDE_PRE_POST,
        },
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
        error: "ivv_live_basket_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
