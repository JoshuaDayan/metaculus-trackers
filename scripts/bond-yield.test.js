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
                "0": [2.85], // Fri Jan 30
                "1": [0], // Sat Jan 31 (placeholder)
                "2": [0], // Sun Feb 01 (placeholder)
                "3": [2.85], // Mon Feb 02
                "4": [2.88], // Tue Feb 03
                "5": [2.88], // Wed Feb 04
                "6": [2.87], // Thu Feb 05
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

test("bond-yield excludes non-trading-day placeholder points", async () => {
  const originalFetch = global.fetch;
  try {
    const fixture = makeBundesbankFixture();
    global.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => fixture,
    });

    const bond = require("../netlify/functions/bond-yield");
    const res = await bond.handler({}, {});
    assert.equal(res.statusCode, 200);

    const body = JSON.parse(res.body);
    assert.equal(body.baselineDate, "2026-01-30");
    assert.equal(body.asOfDate, "2026-02-05");
    assert.equal(body.baselineYield, 2.85);
    assert.equal(body.currentYield, 2.87);

    assert.ok(Array.isArray(body.series));
    assert.deepEqual(
      body.series.map((p) => p.date),
      ["2026-01-30", "2026-02-02", "2026-02-03", "2026-02-04", "2026-02-05"]
    );
    assert.ok(
      body.series.every(
        (p) => typeof p.yield === "number" && Number.isFinite(p.yield) && p.yield !== 0
      )
    );
  } finally {
    global.fetch = originalFetch;
  }
});

