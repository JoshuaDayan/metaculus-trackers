// Netlify Function: Live German 10Y Bund yield from Deutsche Bundesbank API.

const SERIES_ID = "BBSSY.D.REN.EUR.A630.000000WT1010.A";
const URL =
  "https://api.statistiken.bundesbank.de/rest/data/BBSSY/D.REN.EUR.A630.000000WT1010.A";
const BASELINE_DATE = "2026-01-30";
const MAX_SERIES_POINTS = 140;

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

function isWeekday(date) {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
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

exports.handler = async () => {
  try {
    const fetchedAt = new Date().toISOString();

    const res = await fetch(URL, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Netlify bond-yield)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Bundesbank request failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();

    const obs = json?.data?.dataSets?.[0]?.series?.["0:0:0:0:0:0"]?.observations;
    if (!obs || typeof obs !== "object") {
      throw new Error("Bundesbank response missing observations");
    }

    const keys = Object.keys(obs).map((k) => Number(k)).filter((n) => Number.isFinite(n));
    if (!keys.length) throw new Error("Bundesbank response has no observation keys");
    const values = json?.data?.structure?.dimensions?.observation?.[0]?.values;
    const hasValues = Array.isArray(values);

    let series = null;
    let baselineYield = null;
    let asOfDate = null;
    let currentYield = null;

    if (hasValues) {
      const sorted = keys.sort((a, b) => a - b);
      const out = [];
      for (const idx of sorted) {
        const date = values[idx]?.id || values[idx]?.name || null;
        if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (date < BASELINE_DATE) continue;

        const dateObj = parseISODate(date);
        if (!dateObj || !isWeekday(dateObj)) continue;

        const raw = obs[String(idx)]?.[0];
        const y = Math.round(Number(raw) * 100) / 100;
        if (!Number.isFinite(y)) continue;
        if (y === 0) continue; // Bundesbank includes 0.00 on non-trading days (e.g. weekends)

        out.push({ date, yield: y });
      }

      const baselinePoint = out.find((p) => p.date === BASELINE_DATE);
      if (baselinePoint) baselineYield = baselinePoint.yield;

      if (out.length > MAX_SERIES_POINTS) {
        series = out.slice(-MAX_SERIES_POINTS);
      } else {
        series = out;
      }

      if (series.length) {
        asOfDate = series[series.length - 1].date;
        currentYield = series[series.length - 1].yield;
      }
    }

    if (currentYield === null) {
      // Fallback: find latest non-zero weekday observation (handles weekend lookups).
      const sortedDesc = keys.sort((a, b) => b - a);
      for (const idx of sortedDesc) {
        const date = hasValues && values[idx] ? values[idx].id || values[idx].name || null : null;
        if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const dateObj = parseISODate(date);
        if (!dateObj || !isWeekday(dateObj)) continue;
        const raw = obs[String(idx)]?.[0];
        const y = Math.round(Number(raw) * 100) / 100;
        if (!Number.isFinite(y) || y === 0) continue;
        currentYield = y;
        asOfDate = date;
        break;
      }
    }

    if (currentYield === null || asOfDate === null) {
      throw new Error("Bundesbank current yield is not available");
    }

    const body = {
      seriesId: SERIES_ID,
      baselineDate: BASELINE_DATE,
      baselineYield,
      fetchedAt,
      lastUpdated: formatTimestampUtc(fetchedAt),
      asOfDate,
      currentYield,
      series,
      source: {
        provider: "Deutsche Bundesbank",
        url: URL,
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
        error: "bond_yield_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
