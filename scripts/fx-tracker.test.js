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

test("fx-tracker returns aligned time series and correct as-of date", async () => {
  const originalFetch = global.fetch;
  try {
    const bySymbol = {
      "EURUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2026-01-30": 1.2,
          "2026-01-31": 1.2, // weekend (ignored)
          "2026-02-01": 1.2, // weekend (ignored)
          "2026-02-02": 1.21,
          "2026-02-03": 1.22,
        },
      }),
      "JPYUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2026-01-30": 0.0065,
          "2026-02-02": 0.0066,
          "2026-02-03": 0.00655,
        },
      }),
      "GBPUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2026-01-30": 1.38,
          "2026-02-02": 1.379,
          "2026-02-03": 1.385,
        },
      }),
      "CNYUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2026-01-30": 0.144,
          "2026-02-02": 0.143,
          "2026-02-03": 0.145,
        },
      }),
      "CHFUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2026-01-30": 1.308,
          "2026-02-02": 1.3,
          "2026-02-03": 1.305,
        },
      }),
      "AUDUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2026-01-30": 0.705,
          "2026-02-02": 0.7,
          "2026-02-03": 0.71,
        },
      }),
      "CADUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2026-01-30": 0.741,
          "2026-02-02": 0.742,
          "2026-02-03": 0.743,
        },
      }),
      "MXNUSD=X": makeYahooChartFixture({
        closesByDate: {
          "2026-01-30": 0.058,
          "2026-02-02": 0.0582,
          "2026-02-03": 0.0581,
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

    const fx = require("../netlify/functions/fx-tracker");
    const res = await fx.handler(
      { queryStringParameters: { asof: "2026-02-03", noRound: "1" } },
      {}
    );
    assert.equal(res.statusCode, 200);

    const body = JSON.parse(res.body);
    assert.equal(body.baselineDate, "2026-01-30");
    assert.equal(body.asOfDate, "2026-02-03");
    assert.equal(body.leader.code, "EUR");

    assert.deepEqual(body.series.dates, ["2026-01-30", "2026-02-02", "2026-02-03"]);
    assert.equal(body.series.pct.EUR[0], 0);
    assert.equal(body.series.close.JPY[0], 0.0065);

    // Weekend points should not appear in the series dates.
    assert.ok(!body.series.dates.includes("2026-01-31"));
    assert.ok(!body.series.dates.includes("2026-02-01"));
  } finally {
    global.fetch = originalFetch;
  }
});
