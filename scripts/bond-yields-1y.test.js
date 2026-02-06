const test = require("node:test");
const assert = require("node:assert/strict");

function makeBundesbankFixture() {
  // Minimal Bundesbank JSON shape with weekend placeholder zeros.
  return {
    data: {
      dataSets: [
        {
          series: {
            "0:0:0:0:0:0": {
              observations: {
                "0": [2.85], // Fri 2026-01-30
                "1": [0], // Sat 2026-01-31 (placeholder)
                "2": [0], // Sun 2026-02-01 (placeholder)
                "3": [2.85], // Mon 2026-02-02
                "4": [2.88], // Tue 2026-02-03
                "5": [2.87], // Wed 2026-02-04
                "6": [2.86], // Thu 2026-02-05
              },
            },
          },
        },
      ],
      structure: {
        dimensions: {
          observation: [
            {
              values: [
                { id: "2026-01-30" },
                { id: "2026-01-31" },
                { id: "2026-02-01" },
                { id: "2026-02-02" },
                { id: "2026-02-03" },
                { id: "2026-02-04" },
                { id: "2026-02-05" },
              ],
            },
          ],
        },
      },
    },
  };
}

function makeFredCsv(seriesId) {
  return `DATE,${seriesId}\n2026-02-02,4.10\n2026-02-03,4.12\n2026-02-04,4.11\n2026-02-05,4.09\n`;
}

test("bond-yields-1y returns DE from Bundesbank and others from FRED", async () => {
  const originalFetch = global.fetch;
  try {
    const bundesbankFixture = makeBundesbankFixture();
    const fredSeries = new Set([
      "DGS10",
      "IRLTLT01GBD156N",
      "IRLTLT01FRD156N",
      "IRLTLT01ITD156N",
    ]);

    global.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith("https://api.statistiken.bundesbank.de/rest/data/BBSSY/")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => bundesbankFixture };
      }
      if (u.startsWith("https://fred.stlouisfed.org/graph/fredgraph.csv?")) {
        const parsed = new URL(u);
        const id = parsed.searchParams.get("id");
        assert.ok(id, "missing FRED id param");
        assert.ok(fredSeries.has(id), `unexpected FRED series id: ${id}`);
        return { ok: true, status: 200, statusText: "OK", text: async () => makeFredCsv(id) };
      }
      throw new Error(`unexpected fetch url: ${u}`);
    };

    const fn = require("../netlify/functions/bond-yields-1y");
    const res = await fn.handler({ queryStringParameters: { asof: "2026-02-05" } }, {});
    assert.equal(res.statusCode, 200);

    const body = JSON.parse(res.body);
    assert.equal(body.window, "1y");
    assert.equal(body.asOfDate, "2026-02-05");
    assert.ok(body.series);
    assert.ok(Array.isArray(body.series.DE));
    assert.ok(Array.isArray(body.series.US));

    // Weekend placeholder points excluded from Germany.
    assert.deepEqual(
      body.series.DE.map((p) => p.date),
      ["2026-01-30", "2026-02-02", "2026-02-03", "2026-02-04", "2026-02-05"]
    );

    // FRED series parsed.
    assert.deepEqual(body.series.US.map((p) => p.date), ["2026-02-02", "2026-02-03", "2026-02-04", "2026-02-05"]);
  } finally {
    global.fetch = originalFetch;
  }
});

