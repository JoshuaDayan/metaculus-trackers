const test = require("node:test");
const assert = require("node:assert/strict");

function ts(dateStr) {
  return Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
}

function makeYahooChartFixture({ closesByDate }) {
  const dates = Object.keys(closesByDate).sort();
  const timestamps = dates.map((d) => ts(d));
  const closes = dates.map((d) => closesByDate[d]);
  return {
    chart: {
      result: [
        {
          timestamp: timestamps,
          indicators: { quote: [{ close: closes }] },
        },
      ],
      error: null,
    },
  };
}

test("fx-monthly-winners picks the max % mover for the month", async () => {
  const originalFetch = global.fetch;
  try {
    const bySymbol = {
      "EURUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2025-12-31": 1.0,
          "2026-01-30": 1.1, // +10%
        },
      }),
      "JPYUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2025-12-31": 0.0065,
          "2026-01-30": 0.0066,
        },
      }),
      "GBPUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2025-12-31": 1.0,
          "2026-01-30": 1.02,
        },
      }),
      "CNYUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2025-12-31": 0.14,
          "2026-01-30": 0.141,
        },
      }),
      "CHFUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2025-12-31": 1.0,
          "2026-01-30": 1.01,
        },
      }),
      "AUDUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2025-12-31": 0.7,
          "2026-01-30": 0.705,
        },
      }),
      "CADUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2025-12-31": 0.74,
          "2026-01-30": 0.741,
        },
      }),
      "MXNUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2025-12-31": 0.058,
          "2026-01-30": 0.0582,
        },
      }),
    };

    global.fetch = async (url) => {
      const m = String(url).match(/\/v8\/finance\/chart\/([^?]+)/);
      assert.ok(m, `unexpected yahoo url: ${url}`);
      const symbol = decodeURIComponent(m[1]);
      const fixture = bySymbol[symbol];
      assert.ok(fixture, `missing fixture for symbol: ${symbol}`);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => fixture,
      };
    };

    const fn = require("../netlify/functions/fx-monthly-winners");
    const res = await fn.handler(
      { queryStringParameters: { startMonth: "2026-01", endMonth: "2026-01" } },
      {}
    );
    assert.equal(res.statusCode, 200);

    const body = JSON.parse(res.body);
    assert.equal(body.startMonth, "2026-01");
    assert.equal(body.endMonth, "2026-01");
    assert.ok(Array.isArray(body.months));
    assert.equal(body.months.length, 1);

    const m0 = body.months[0];
    assert.equal(m0.month, "2026-01");
    assert.equal(m0.baselineDate, "2025-12-31");
    assert.equal(m0.asOfDate, "2026-01-30");
    assert.equal(m0.winner.code, "EUR");
    assert.ok(m0.winner.pctChange > 9.99 && m0.winner.pctChange < 10.01);
    assert.ok(m0.changes && typeof m0.changes.EUR === "number");
  } finally {
    global.fetch = originalFetch;
  }
});

