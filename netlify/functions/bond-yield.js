// Netlify Function: Live German 10Y Bund yield from Deutsche Bundesbank API.

const SERIES_ID = "BBSSY.D.REN.EUR.A630.000000WT1010.A";
const URL =
  "https://api.statistiken.bundesbank.de/rest/data/BBSSY/D.REN.EUR.A630.000000WT1010.A";

const DEFAULT_CDN_CACHE_SECONDS = 60 * 60; // 1 hour
const DEFAULT_STALE_WHILE_REVALIDATE_SECONDS = 24 * 60 * 60; // 1 day

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
    const latestIndex = Math.max(...keys);

    const rawYield = obs[String(latestIndex)]?.[0];
    const currentYield = Math.round(Number(rawYield) * 100) / 100;
    if (!Number.isFinite(currentYield)) throw new Error("Bundesbank current yield is not a number");

    let observationDate = null;
    try {
      const values = json?.data?.structure?.dimensions?.observation?.[0]?.values;
      if (Array.isArray(values) && values[latestIndex]) {
        observationDate = values[latestIndex].id || values[latestIndex].name || null;
      }
    } catch {
      // optional
    }

    const body = {
      series: SERIES_ID,
      fetchedAt,
      lastUpdated: formatTimestampUtc(fetchedAt),
      observationDate,
      currentYield,
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

