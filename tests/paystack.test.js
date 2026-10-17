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
