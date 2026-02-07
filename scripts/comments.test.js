const test = require("node:test");
const assert = require("node:assert/strict");

test("comments lists submissions for a thread via Netlify API", async () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  try {
    process.env.SITE_ID = "site_123";
    process.env.NETLIFY_API_TOKEN = "token_abc";

    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts });
      if (String(url).endsWith("/api/v1/sites/site_123/forms")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [
            { id: "form_currency", name: "sf-comments-currency" },
            { id: "form_bond", name: "sf-comments-bond" },
          ],
        };
      }
      if (String(url).includes("/api/v1/forms/form_currency/submissions")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [
            {
              id: "sub_1",
              created_at: "2026-02-06T10:00:00.000Z",
              data: { handle: "TetlockSuperSoldier101", message: "First!" },
            },
            {
              id: "sub_2",
              created_at: "2026-02-06T10:01:00.000Z",
              data: { handle: "BrierBaron42", message: "Nice dashboard." },
            },
          ],
        };
      }
      throw new Error(`unexpected fetch url: ${url}`);
    };

    const fn = require("../netlify/functions/comments");
    const res = await fn.handler({ httpMethod: "GET", queryStringParameters: { thread: "currency" } }, {});
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.thread, "currency");
    assert.equal(body.formName, "sf-comments-currency");
    assert.ok(Array.isArray(body.comments));
    assert.equal(body.comments.length, 2);
    assert.equal(body.comments[0].handle, "TetlockSuperSoldier101");
    assert.equal(body.comments[1].message, "Nice dashboard.");

    assert.ok(calls.length >= 2);
  } finally {
    global.fetch = originalFetch;
    process.env = originalEnv;
  }
});

