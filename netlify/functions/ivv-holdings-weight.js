// Netlify Function: IVV (iShares Core S&P 500 ETF) basket weight tracker from iShares holdings CSV.
//
// Metaculus-style question: total weight of a basket of tickers in IVV as of a resolution date.

const IVV_HOLDINGS_CSV_URL_TEMPLATE =
  "https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf/" +
  "1467271812596.ajax?fileType=csv&fileName=IVV_holdings&dataType=fund&asOfDate={asOfDate}";

const DEFAULT_BASKET_TICKERS = ["NVDA", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "AMD"];
const DEFAULT_WINDOW_MONTHS = 6;
const DEFAULT_FETCH_CONCURRENCY = 6;
const DEFAULT_COARSE_STRIDE_DAYS = 5; // weekly-ish sampling for older history

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

function addMonths(date, months) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  const target = new Date(Date.UTC(year, month + months, 1));
  const targetYear = target.getUTCFullYear();
  const targetMonth = target.getUTCMonth();
  const maxDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, maxDay));
  return target;
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

  if (holdingsAsOfLabel.trim() === "-") {
    return { available: false, holdingsAsOfLabel: holdingsAsOfLabel.trim(), weightByTicker: null, totalWeight: null };
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

    // Disclaimers start after a blank line; skip once they appear.
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
    // We do not early-exit based on "seen" because duplicates can exist (e.g., multiple share classes);
    // summing and finishing the file keeps behavior stable.
  }

  const missingTickers = basketTickers.filter((t) => weightByTicker[t.toUpperCase()] === undefined);
  if (missingTickers.length === basketTickers.length) {
    // If *none* of the basket tickers are present, treat this as a missing snapshot rather than
    // returning a misleading 0% total weight.
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
      "User-Agent": "Mozilla/5.0 (Netlify ivv-holdings-weight)",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`iShares request failed: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
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

    const asofParam = typeof qs.asof === "string" ? qs.asof : null;
    const asOfLimit = (asofParam && parseISODate(asofParam)) || new Date(Date.now());

    const daysParam = typeof qs.days === "string" ? Number(qs.days) : null;
    const monthsParam = typeof qs.months === "string" ? Number(qs.months) : DEFAULT_WINDOW_MONTHS;
    const lookbackDays = Number.isFinite(daysParam) ? Math.max(0, Math.min(730, Math.floor(daysParam))) : null;
    const lookbackMonths = Number.isFinite(monthsParam) ? Math.max(0, Math.min(24, Math.floor(monthsParam))) : DEFAULT_WINDOW_MONTHS;

    const strideParamRaw = typeof qs.stride === "string" ? Number(qs.stride) : null;
    const strideFromParam = Number.isFinite(strideParamRaw)
      ? Math.max(1, Math.min(30, Math.floor(strideParamRaw)))
      : null;
    const stride = strideFromParam !== null ? strideFromParam : lookbackDays !== null ? 1 : DEFAULT_COARSE_STRIDE_DAYS;

    const concurrencyParam = typeof qs.concurrency === "string" ? Number(qs.concurrency) : null;
    const concurrency = Number.isFinite(concurrencyParam)
      ? Math.max(1, Math.min(12, Math.floor(concurrencyParam)))
      : DEFAULT_FETCH_CONCURRENCY;

    const startDate = lookbackDays !== null ? addDays(asOfLimit, -lookbackDays) : addMonths(asOfLimit, -lookbackMonths);

    const datesToQuery = [];
    let cur = startDate;
    while (cur <= asOfLimit) {
      if (isWeekday(cur)) datesToQuery.push(toISODate(cur));
      cur = addDays(cur, 1);
    }

    if (!datesToQuery.length) {
      throw new Error("No weekday dates in requested window");
    }

    // Keep newer history dense (daily) and older history coarse (stride) to avoid
    // fetching hundreds of iShares snapshots on a cold cache miss.
    const yearStartIso = `${asOfLimit.getUTCFullYear()}-01-01`;

    const selectedDatesSet = new Set();
    let coarseIdx = 0;
    for (const isoDate of datesToQuery) {
      if (isoDate >= yearStartIso) {
        selectedDatesSet.add(isoDate);
      } else {
        if (coarseIdx % stride === 0) selectedDatesSet.add(isoDate);
        coarseIdx += 1;
      }
    }

    // Always include the latest weekday we have in-range.
    selectedDatesSet.add(datesToQuery[datesToQuery.length - 1]);

    const selectedDates = Array.from(selectedDatesSet).sort();
    if (!selectedDates.length) {
      throw new Error("No weekday dates selected");
    }

    const points = await mapWithConcurrency(selectedDates, concurrency, async (isoDate) => {
      const dateObj = parseISODate(isoDate);
      if (!dateObj) return null;
      const asOfDateParam = toAsOfDateParam(dateObj);
      try {
        const csvText = await fetchHoldingsCsvText(asOfDateParam);
        const parsed = parseHoldingsCsvForBasket(csvText, { basketTickers });
        if (!parsed.available) return null;

        if (!Number.isFinite(parsed.totalWeight) || parsed.totalWeight < 0 || parsed.totalWeight > 100) return null;

        return {
          date: isoDate,
          holdingsAsOfLabel: parsed.holdingsAsOfLabel,
          weightByTicker: parsed.weightByTicker,
          totalWeight: parsed.totalWeight,
          missingTickers: parsed.missingTickers || [],
        };
      } catch (err) {
        // Treat any per-date failure as a missing snapshot; we'll still serve older data if available.
        return null;
      }
    });

    const seriesPoints = points.filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!seriesPoints.length) {
      throw new Error("No holdings snapshots found in requested window (all dates returned Fund Holdings as of '-')");
    }

    const dates = seriesPoints.map((p) => p.date);
    const total = seriesPoints.map((p) => p.totalWeight);
    const byTicker = {};
    for (const t of basketTickers) {
      byTicker[t] = seriesPoints.map((p) => p.weightByTicker[t]);
    }

    const latest = seriesPoints[seriesPoints.length - 1];
    const latestMissing = latest.missingTickers || [];
    const basket = {
      tickers: basketTickers,
      asOfDate: latest.date,
      holdingsAsOfLabel: latest.holdingsAsOfLabel,
      weights: latest.weightByTicker,
      totalWeight: latest.totalWeight,
      missingTickers: latestMissing,
    };

    const targetParam = typeof qs.target === "string" ? qs.target : null;
    const targetDateObj = targetParam ? parseISODate(targetParam) : null;
    let target = null;
    if (targetDateObj) {
      const targetIso = toISODate(targetDateObj);
      const asOfLimitIso = toISODate(asOfLimit);

      // If the target date is in the future (relative to asOfLimit), don't even attempt a fetch.
      if (targetIso > asOfLimitIso) {
        target = {
          date: targetIso,
          available: false,
          holdingsAsOfLabel: null,
          weights: null,
          totalWeight: null,
        };
      } else {
        const fromSeries = seriesPoints.find((p) => p.date === targetIso) || null;
        if (fromSeries) {
          target = {
            date: targetIso,
            available: true,
            holdingsAsOfLabel: fromSeries.holdingsAsOfLabel,
            weights: fromSeries.weightByTicker,
            totalWeight: fromSeries.totalWeight,
          };
        } else {
          try {
            const asOfDateParam = toAsOfDateParam(targetDateObj);
            const csvText = await fetchHoldingsCsvText(asOfDateParam);
            const parsed = parseHoldingsCsvForBasket(csvText, { basketTickers });
            target = {
              date: targetIso,
              available: parsed.available,
              holdingsAsOfLabel: parsed.holdingsAsOfLabel,
              weights: parsed.weightByTicker,
              totalWeight: parsed.totalWeight,
            };
          } catch (_) {
            target = {
              date: targetIso,
              available: false,
              holdingsAsOfLabel: null,
              weights: null,
              totalWeight: null,
            };
          }
        }
      }
    }

    const body = {
      window: lookbackDays !== null ? { type: "days", value: lookbackDays } : { type: "months", value: lookbackMonths },
      stride,
      asOfLimit: toISODate(asOfLimit),
      startDate: toISODate(startDate),
      fetchedAt,
      lastUpdated: formatTimestampUtc(fetchedAt),
      basket,
      series: { dates, total, byTicker },
      target,
      sampling: {
        denseFrom: yearStartIso,
        coarseStrideDays: stride,
        selectedDates: selectedDates.length,
        snapshots: seriesPoints.length,
      },
      source: {
        provider: "iShares / BlackRock",
        format: "csv",
        urlTemplate: IVV_HOLDINGS_CSV_URL_TEMPLATE,
        note: 'Downloads holdings via the documented iShares endpoint with the "asOfDate=YYYYMMDD" query parameter.',
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
        error: "ivv_holdings_weight_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
