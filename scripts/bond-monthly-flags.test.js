const test = require("node:test");
const assert = require("node:assert/strict");

function makeBundesbankFixture() {
  return {
    data: {
      dataSets: [
        {
          series: {
            "0:0:0:0:0:0": {
              observations: {
                "0": [2.0], // 2025-12-31 baseline
                "1": [0], // 2026-01-01 placeholder (ignored by weekday filter anyway)
                "2": [2.05], // 2026-01-02
                "3": [2.21], // 2026-01-15 (breaches +20bp trigger)
                "4": [2.1], // 2026-01-30
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
                { id: "2025-12-31" },
                { id: "2026-01-01" },
                { id: "2026-01-02" },
                { id: "2026-01-15" },
                { id: "2026-01-30" },
              ],
            },
          ],
        },
      },
    },
  };
}

test("bond-monthly-flags marks a month YES when ±20bp is breached", async () => {
  const originalFetch = global.fetch;
  try {
    const fixture = makeBundesbankFixture();
    global.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => fixture,
    });

    const fn = require("../netlify/functions/bond-monthly-flags");
    const res = await fn.handler(
      { queryStringParameters: { startMonth: "2026-01", endMonth: "2026-01" } },
      {}
    );
    assert.equal(res.statusCode, 200);

    const body = JSON.parse(res.body);
    assert.equal(body.seriesId, "BBSSY.D.REN.EUR.A630.000000WT1010.A");
    assert.equal(body.thresholdBp, 20);
    assert.equal(body.startMonth, "2026-01");
    assert.equal(body.endMonth, "2026-01");
    assert.ok(Array.isArray(body.months));
    assert.equal(body.months.length, 1);

    const m = body.months[0];
    assert.equal(m.month, "2026-01");
    assert.equal(m.baselineDate, "2025-12-31");
    assert.equal(m.baselineYield, 2.0);
    assert.equal(m.upperTrigger, 2.2);
    assert.equal(m.lowerTrigger, 1.8);
    assert.equal(m.maxYield, 2.21);
    assert.equal(m.minYield, 2.05);
    assert.equal(m.status, "YES");
    assert.equal(m.breachedUpper, true);
    assert.equal(m.breachedLower, false);
    assert.equal(m.breach, "UPPER");
  } finally {
    global.fetch = originalFetch;
  }
});

