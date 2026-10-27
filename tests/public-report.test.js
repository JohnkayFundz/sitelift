import test from "node:test";
import assert from "node:assert/strict";
import { createPublicReportHandler } from "../api/report/[id].js";

function response() {
  return {
    statusCode: null, headers: {}, body: "",
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(body) { this.body = body; return this; }
  };
}

test("public report renders escaped Open Graph metadata and WhatsApp sharing", async () => {
  const id = "decb676a-e5fb-40eb-9ea6-e983b2a4840b";
  const db = { from(table) {
    assert.equal(table, "audits");
    return { select() { return this; }, eq(column, value) { assert.equal(column, "id"); assert.equal(value, id); return this; }, async maybeSingle() {
      return { error: null, data: { id, report: { url: "https://example.com", finalUrl: "https://example.com/", strategy: "mobile", fetchedAt: "2026-10-27T12:00:00.000Z", scores: [{ key: "performance", label: "<script>alert(1)</script>", value: 88, rating: "good", ratingLabel: "Good" }], metrics: [], opportunities: [{ id: "unused-css", title: "Reduce unused CSS", description: "Review CSS delivery.", displayValue: "1.2 s" }] } } };
    } };
  } };
  const handler = createPublicReportHandler({ getSupabaseAdmin: () => db });
  const res = response();
  await handler({ method: "GET", query: { id } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["Content-Type"], /text\/html/);
  assert.match(res.body, /property="og:title"/);
  assert.match(res.body, /https:\/\/sitelift\.vercel\.app\/report\/decb676a-e5fb-40eb-9ea6-e983b2a4840b/);
  assert.match(res.body, /Send to business owner on WhatsApp/);
  assert.doesNotMatch(res.body, /<script>alert\(1\)<\/script>/);
  assert.match(res.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("public report rejects invalid IDs without querying the database", async () => {
  let queries = 0;
  const handler = createPublicReportHandler({ getSupabaseAdmin: () => { queries += 1; throw new Error("must not query"); } });
  const res = response();
  await handler({ method: "GET", query: { id: "../private" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(queries, 0);
});
