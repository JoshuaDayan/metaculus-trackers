const test = require("node:test");
const assert = require("node:assert/strict");

function makeHoldingsCsv({ asOfLabel, rows }) {
  const header = ["Ticker", "Name", "Weight (%)"];
  const lines = [];
  lines.push("\uFEFFiShares Core S&P 500 ETF");
  lines.push(`Fund Holdings as of,"${asOfLabel}"`);
  lines.push('Inception Date,"May 15, 2000"');
  lines.push("");
  lines.push(header.join(","));
  for (const r of rows) {
    const ticker = r.ticker;
    const name = r.name || ticker;
    const weight = r.weight;
    lines.push(`"${ticker}","${name}","${weight}"`);
  }
  lines.push("");
  lines.push('"The content contained herein is owned or licensed by BlackRock."');
  return lines.join("\n");
}

test("ivv-holdings-weight returns basket + series for available dates", async () => {
  const originalFetch = global.fetch;
  try {
    const fixturesByAsOf = {
      // Missing dates (Fund Holdings as of "-") should be skipped.
      20260129: makeHoldingsCsv({ asOfLabel: "-", rows: [] }),
      20260202: makeHoldingsCsv({ asOfLabel: "-", rows: [] }),

      20260130: makeHoldingsCsv({
        asOfLabel: "Jan 30, 2026",
        rows: [
          { ticker: "NVDA", weight: "7.80" },
          { ticker: "MSFT", weight: "5.10" },
        ],
      }),
      20260203: makeHoldingsCsv({
        asOfLabel: "Feb 03, 2026",
        rows: [
          { ticker: "NVDA", weight: "7.90" },
          { ticker: "MSFT", weight: "5.00" },
        ],
      }),
    };

    global.fetch = async (url) => {
      const m = String(url).match(/asOfDate=(\d{8})/);
      assert.ok(m, `unexpected iShares url: ${url}`);
      const asOf = Number(m[1]);
      const body = fixturesByAsOf[asOf] || makeHoldingsCsv({ asOfLabel: "-", rows: [] });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => body,
      };
    };

    const fn = require("../netlify/functions/ivv-holdings-weight");
    const res = await fn.handler(
      {
        queryStringParameters: {
          asof: "2026-02-03",
          days: "5",
          tickers: "NVDA,MSFT",
          concurrency: "2",
        },
      },
      {}
    );

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.basket.tickers, ["NVDA", "MSFT"]);
    assert.equal(body.basket.asOfDate, "2026-02-03");
    assert.equal(body.basket.totalWeight, 12.9);

    assert.deepEqual(body.series.dates, ["2026-01-30", "2026-02-03"]);
    assert.deepEqual(body.series.total, [12.9, 12.9]);
    assert.deepEqual(body.series.byTicker.NVDA, [7.8, 7.9]);
    assert.deepEqual(body.series.byTicker.MSFT, [5.1, 5.0]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("ivv-holdings-weight treats missing tickers as 0 (but keeps snapshot)", async () => {
  const originalFetch = global.fetch;
  try {
    const fixturesByAsOf = {
      20260211: makeHoldingsCsv({
        asOfLabel: "Feb 11, 2026",
        rows: [{ ticker: "NVDA", weight: "7.78" }],
      }),
    };

    global.fetch = async (url) => {
      const m = String(url).match(/asOfDate=(\d{8})/);
      assert.ok(m, `unexpected iShares url: ${url}`);
      const asOf = Number(m[1]);
      const body = fixturesByAsOf[asOf] || makeHoldingsCsv({ asOfLabel: "-", rows: [] });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => body,
      };
    };

    const fn = require("../netlify/functions/ivv-holdings-weight");
    const res = await fn.handler(
      {
        queryStringParameters: {
          asof: "2026-02-11",
          days: "0",
          tickers: "NVDA,MSFT",
        },
      },
      {}
    );

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.basket.totalWeight, 7.78);
    assert.deepEqual(body.basket.missingTickers, ["MSFT"]);
    assert.equal(body.basket.weights.NVDA, 7.78);
    assert.equal(body.basket.weights.MSFT, 0);

    assert.deepEqual(body.series.dates, ["2026-02-11"]);
    assert.deepEqual(body.series.byTicker.NVDA, [7.78]);
    assert.deepEqual(body.series.byTicker.MSFT, [0]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("ivv-holdings-weight includes target when provided (available=false)", async () => {
  const originalFetch = global.fetch;
  try {
    const fixturesByAsOf = {
      20260211: makeHoldingsCsv({
        asOfLabel: "Feb 11, 2026",
        rows: [
          { ticker: "NVDA", weight: "7.78" },
          { ticker: "MSFT", weight: "5.06" },
        ],
      }),
      20260227: makeHoldingsCsv({ asOfLabel: "-", rows: [] }),
    };

    global.fetch = async (url) => {
      const m = String(url).match(/asOfDate=(\d{8})/);
      assert.ok(m, `unexpected iShares url: ${url}`);
      const asOf = Number(m[1]);
      const body = fixturesByAsOf[asOf] || makeHoldingsCsv({ asOfLabel: "-", rows: [] });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => body,
      };
    };

    const fn = require("../netlify/functions/ivv-holdings-weight");
    const res = await fn.handler(
      {
        queryStringParameters: {
          asof: "2026-02-11",
          days: "0",
          tickers: "NVDA,MSFT",
          target: "2026-02-27",
        },
      },
      {}
    );

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.target.date, "2026-02-27");
    assert.equal(body.target.available, false);
    assert.equal(body.target.totalWeight, null);
  } finally {
    global.fetch = originalFetch;
  }
});
