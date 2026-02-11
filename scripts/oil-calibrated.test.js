const test = require("node:test");
const assert = require("node:assert/strict");

function ts(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function makeYahooChartFixture({ timestampsSec, closes, meta }) {
  return {
    chart: {
      result: [
        {
          timestamp: timestampsSec,
          indicators: { quote: [{ close: closes }] },
          meta: meta || {},
        },
      ],
      error: null,
    },
  };
}

function makeEiaFixture({ rows }) {
  return { response: { data: rows } };
}

function withFixedNow(fixedIso, fn) {
  const RealDate = Date;
  const fixed = new RealDate(fixedIso);
  global.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) return new RealDate(fixed.getTime());
      return new RealDate(...args);
    }
    static now() {
      return fixed.getTime();
    }
    static UTC(...args) {
      return RealDate.UTC(...args);
    }
    static parse(str) {
      return RealDate.parse(str);
    }
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.Date = RealDate;
    });
}

test("oil-calibrated computes EWMA basis and calibrated spread", async () => {
  await withFixedNow("2026-02-11T15:30:00Z", async () => {
    const originalFetch = global.fetch;
    const originalEnv = process.env.EIA_API_KEY;
    try {
      process.env.EIA_API_KEY = "test";

      // WTI raw basis (EIA - futures_settle): [1, 1, 1, 0] across 4 dates.
      // Brent raw basis constant: [2, 2, 2, 2].
      const eiaRows = [
        { period: "2026-02-06", series: "RWTC", value: 50.0 },
        { period: "2026-02-06", series: "RBRTE", value: 62.0 },
        { period: "2026-02-05", series: "RWTC", value: 51.0 },
        { period: "2026-02-05", series: "RBRTE", value: 62.0 },
        { period: "2026-02-04", series: "RWTC", value: 51.0 },
        { period: "2026-02-04", series: "RBRTE", value: 62.0 },
        { period: "2026-02-03", series: "RWTC", value: 51.0 },
        { period: "2026-02-03", series: "RBRTE", value: 62.0 },
      ];

      const eiaFixture = makeEiaFixture({ rows: eiaRows });

      const dailyDates = ["2026-02-03", "2026-02-04", "2026-02-05", "2026-02-06"];
      const wtiDailyCloses = dailyDates.map(() => 50.0); // last day raw basis 0: EIA=50, close=50
      const brentDailyCloses = dailyDates.map(() => 60.0);

      const wtiDailyFixture = makeYahooChartFixture({
        timestampsSec: dailyDates.map((d) => ts(`${d}T00:00:00Z`)),
        closes: wtiDailyCloses,
        meta: { regularMarketPrice: 52.0, regularMarketTime: ts("2026-02-11T15:25:00Z") },
      });
      const brentDailyFixture = makeYahooChartFixture({
        timestampsSec: dailyDates.map((d) => ts(`${d}T00:00:00Z`)),
        closes: brentDailyCloses,
        meta: { regularMarketPrice: 62.0, regularMarketTime: ts("2026-02-11T15:25:00Z") },
      });

      const intraTs = [ts("2026-02-11T14:00:00Z"), ts("2026-02-11T14:05:00Z")];
      const wtiIntraFixture = makeYahooChartFixture({
        timestampsSec: intraTs,
        closes: [52.1, 52.2],
        meta: { regularMarketPrice: 52.0, regularMarketTime: ts("2026-02-11T15:25:00Z") },
      });
      const brentIntraFixture = makeYahooChartFixture({
        timestampsSec: intraTs,
        closes: [62.3, 62.4],
        meta: { regularMarketPrice: 62.0, regularMarketTime: ts("2026-02-11T15:25:00Z") },
      });

      global.fetch = async (url) => {
        const u = String(url);
        if (u.startsWith("https://api.eia.gov/")) {
          return { ok: true, status: 200, statusText: "OK", json: async () => eiaFixture };
        }

        const m = u.match(/\/v8\/finance\/chart\/([^?]+)/);
        assert.ok(m, `unexpected yahoo url: ${u}`);
        const symbol = decodeURIComponent(m[1]);
        const qs = new URL(u).searchParams;
        const interval = qs.get("interval");

        if (symbol === "CL=F") {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => (interval === "1d" ? wtiDailyFixture : wtiIntraFixture),
          };
        }
        if (symbol === "BZ=F") {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => (interval === "1d" ? brentDailyFixture : brentIntraFixture),
          };
        }
        assert.fail(`unexpected symbol: ${symbol}`);
      };

      const fn = require("../netlify/functions/oil-calibrated");
      const res = await fn.handler({}, {});
      assert.equal(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.equal(body.metaculus.targetDate, "2026-03-04");
      assert.equal(body.metaculus.resolution.status, "pending");
      assert.equal(body.basis.window_days, 10);

      // Basis age from 2026-02-06 (Fri) to 2026-02-11 (Wed) = 3 business days (Mon/Tue/Wed).
      assert.equal(body.basis_age_days, 3);

      // WTI smoothed basis should be lambda (~0.794) after [1,1,1,0].
      const lambda = Math.pow(0.5, 1 / 3);
      assert.ok(Math.abs(body.wti.smoothed_basis - lambda) < 0.01);
      assert.equal(body.brent.smoothed_basis, 2.0);

      // Intraday series exists and spread uses calibrated basis.
      assert.equal(body.intraday.timestamps.length, 2);
      assert.equal(body.intraday.calibrated.spread.length, 2);
      assert.equal(body.intraday.calibrated.spread[0], 11.41);
    } finally {
      global.fetch = originalFetch;
      if (originalEnv === undefined) delete process.env.EIA_API_KEY;
      else process.env.EIA_API_KEY = originalEnv;
    }
  });
});

test("oil-calibrated interpolates target spread after deadline when missing", async () => {
  await withFixedNow("2026-03-15T12:00:00Z", async () => {
    const originalFetch = global.fetch;
    const originalEnv = process.env.EIA_API_KEY;
    try {
      process.env.EIA_API_KEY = "test";

      const eiaRows = [
        // Target 2026-03-04 is intentionally missing.
        { period: "2026-03-05", series: "RWTC", value: 54.0 },
        { period: "2026-03-05", series: "RBRTE", value: 64.0 },
        { period: "2026-03-03", series: "RWTC", value: 50.0 },
        { period: "2026-03-03", series: "RBRTE", value: 60.0 },
      ];
      const eiaFixture = makeEiaFixture({ rows: eiaRows });

      const dailyDates = ["2026-03-03", "2026-03-05"];
      const wtiDailyFixture = makeYahooChartFixture({
        timestampsSec: dailyDates.map((d) => ts(`${d}T00:00:00Z`)),
        closes: [50.0, 54.0],
        meta: { regularMarketPrice: 55.0, regularMarketTime: ts("2026-03-15T11:55:00Z") },
      });
      const brentDailyFixture = makeYahooChartFixture({
        timestampsSec: dailyDates.map((d) => ts(`${d}T00:00:00Z`)),
        closes: [60.0, 64.0],
        meta: { regularMarketPrice: 65.0, regularMarketTime: ts("2026-03-15T11:55:00Z") },
      });

      const intraTs = [ts("2026-03-15T11:50:00Z")];
      const wtiIntraFixture = makeYahooChartFixture({
        timestampsSec: intraTs,
        closes: [55.0],
        meta: { regularMarketPrice: 55.0, regularMarketTime: ts("2026-03-15T11:55:00Z") },
      });
      const brentIntraFixture = makeYahooChartFixture({
        timestampsSec: intraTs,
        closes: [65.0],
        meta: { regularMarketPrice: 65.0, regularMarketTime: ts("2026-03-15T11:55:00Z") },
      });

      global.fetch = async (url) => {
        const u = String(url);
        if (u.startsWith("https://api.eia.gov/")) {
          return { ok: true, status: 200, statusText: "OK", json: async () => eiaFixture };
        }
        const m = u.match(/\/v8\/finance\/chart\/([^?]+)/);
        assert.ok(m, `unexpected yahoo url: ${u}`);
        const symbol = decodeURIComponent(m[1]);
        const qs = new URL(u).searchParams;
        const interval = qs.get("interval");

        if (symbol === "CL=F") {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => (interval === "1d" ? wtiDailyFixture : wtiIntraFixture),
          };
        }
        if (symbol === "BZ=F") {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => (interval === "1d" ? brentDailyFixture : brentIntraFixture),
          };
        }
        assert.fail(`unexpected symbol: ${symbol}`);
      };

      const fn = require("../netlify/functions/oil-calibrated");
      const res = await fn.handler({}, {});
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);

      assert.equal(body.metaculus.resolution.status, "interpolated");
      assert.equal(body.metaculus.resolution.value, 10.0);
      assert.equal(body.metaculus.resolution.interpolation.prevDate, "2026-03-03");
      assert.equal(body.metaculus.resolution.interpolation.nextDate, "2026-03-05");
    } finally {
      global.fetch = originalFetch;
      if (originalEnv === undefined) delete process.env.EIA_API_KEY;
      else process.env.EIA_API_KEY = originalEnv;
    }
  });
});

