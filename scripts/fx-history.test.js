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

test("fx-history returns 1Y series including DXY", async () => {
  const originalFetch = global.fetch;
  try {
    const bySymbol = {
      "DX-Y.NYB": makeYahooChartFixture({
        closesByDate: {
          "2025-02-05": 100,
          "2026-02-01": 101, // weekend (ignored)
          "2026-02-03": 109,
          "2026-02-04": 110,
          "2026-02-05": 111,
        },
      }),
      "EURUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2025-02-05": 1.1,
          "2026-02-03": 1.2,
          "2026-02-04": 1.21,
          "2026-02-05": 1.22,
        },
      }),
      "JPYUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2025-02-05": 0.0065,
          "2026-02-03": 0.0066,
          "2026-02-04": 0.00655,
          "2026-02-05": 0.0067,
        },
      }),
      "GBPUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2025-02-05": 1.3,
          "2026-02-03": 1.31,
          "2026-02-04": 1.32,
          "2026-02-05": 1.33,
        },
      }),
      "CNYUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2025-02-05": 0.14,
          "2026-02-03": 0.141,
          "2026-02-04": 0.142,
          "2026-02-05": 0.143,
        },
      }),
      "CHFUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2025-02-05": 1.2,
          "2026-02-03": 1.21,
          "2026-02-04": 1.22,
          "2026-02-05": 1.23,
        },
      }),
      "AUDUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2025-02-05": 0.7,
          "2026-02-03": 0.71,
          "2026-02-04": 0.72,
          "2026-02-05": 0.73,
        },
      }),
      "CADUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2025-02-05": 0.74,
          "2026-02-03": 0.741,
          "2026-02-04": 0.742,
          "2026-02-05": 0.743,
        },
      }),
      "MXNUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2025-02-05": 0.058,
          "2026-02-03": 0.0581,
          "2026-02-04": 0.0582,
          "2026-02-05": 0.0583,
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

    const fxHistory = require("../netlify/functions/fx-history");
    const res = await fxHistory.handler(
      { queryStringParameters: { asof: "2026-02-05", noRound: "1" } },
      {}
    );
    assert.equal(res.statusCode, 200);

    const body = JSON.parse(res.body);
    assert.equal(body.window, "1y");
    assert.equal(body.baselineDate, "2025-02-05");
    assert.equal(body.asOfDate, "2026-02-05");
    assert.ok(body.series);
    assert.ok(body.series.close);
    assert.ok(body.series.pct);
    assert.ok(Array.isArray(body.series.dates));

    // Weekend should be excluded.
    assert.ok(!body.series.dates.includes("2026-02-01"));

    // DXY is included and baseline is 0%.
    assert.equal(body.series.pct.DXY[0], 0);
    assert.ok(Math.abs(body.series.pct.DXY.at(-1) - 11) < 1e-9);
  } finally {
    global.fetch = originalFetch;
  }
});

