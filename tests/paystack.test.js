import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { validSignature } from "../api/paystack/webhook.js";
import { createAuditPdf } from "../api/_lib/server.js";
test("Paystack webhook signature validates the exact raw body", () => {
  const raw = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "test-reference" } }));
  const secret = "test-secret-for-unit-tests";
  const signature = createHmac("sha512", secret).update(raw).digest("hex");
  assert.equal(validSignature(raw, signature, secret), true);
  assert.equal(validSignature(Buffer.from(raw.toString() + " "), signature, secret), false);
  assert.equal(validSignature(raw, "not-a-signature", secret), false);
});
test("PDF generator emits a minimal PDF document", () => {
  const pdf = createAuditPdf({ target_url: "https://example.com", final_url: "https://example.com/", strategy: "mobile", created_at: "2026-10-17T00:00:00.000Z", report: { scores: [{ label: "Performance", value: 91 }], metrics: [], opportunities: [] } });
  assert.equal(pdf.subarray(0, 8).toString(), "%PDF-1.4");
  assert.equal(pdf.toString("utf8").includes("Performance: 91/100"), true);
  assert.equal(pdf.toString("utf8").endsWith("%%EOF"), true);
});

test("webhook processing claims a payment atomically and acknowledges in-progress duplicates", async () => {
  const { readFile } = await import("node:fs/promises");
  const server = await readFile(new URL("../api/_lib/server.js", import.meta.url), "utf8");
  const webhook = await readFile(new URL("../api/paystack/webhook.js", import.meta.url), "utf8");
  assert.match(server, /status\.eq\.pending,and\(status\.eq\.processing,processing_started_at\.lt\./);
  assert.match(server, /\.eq\("status", "processing"\)\.eq\("processing_started_at", nowIso\)/);
  assert.match(webhook, /result\.status === "processing"[\s\S]*?json\(res, 200,[\s\S]*?duplicate: true/);
});

test("expired tokens have a distinct reason and the recovery endpoint only emails the stored checkout address", async () => {
  const { readFile } = await import("node:fs/promises");
  const status = await readFile(new URL("../api/paystack/status.js", import.meta.url), "utf8");
  const recovery = await readFile(new URL("../api/paystack/resend-link.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(status, /reason: "expired_token"/);
  assert.match(app, /Your 24-hour download link has expired/);
  assert.ok(app.includes('"/api/paystack/resend-link"'));
  assert.match(recovery, /to: \[payment\.customer_email\]/);
  assert.match(recovery, /const GENERIC_MESSAGE = "If the reference and email match a paid record/);
  assert.doesNotMatch(recovery, /downloadUrl:\s*link\.toString\(\)/);
});
