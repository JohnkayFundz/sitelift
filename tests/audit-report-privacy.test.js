import test from "node:test";
import assert from "node:assert/strict";
import { sanitizePublicAuditReport } from "../api/audit/[id].js";

test("public audit report sanitizer removes unexpected stored metadata", () => {
  const report = {
    url: "https://example.com",
    finalUrl: "https://www.example.com",
    strategy: "mobile",
    fetchedAt: "2026-10-24T09:00:00.000Z",
    scores: [{
      key: "performance",
      label: "Performance",
      value: 92,
      rating: "good",
      ratingLabel: "Good",
      clientIp: "192.0.2.10",
      internalNotes: "do not expose",
      payment: { reference: "pay_test_secret" }
    }],
    metrics: [{
      key: "largest-contentful-paint",
      label: "Largest Contentful Paint",
      value: "2.1 s",
      internalHeaders: { authorization: "Bearer mock-secret" }
    }],
    opportunities: [{
      id: "unused-javascript",
      title: "Reduce unused JavaScript",
      displayValue: "Potential savings",
      description: "Review bundles.",
      customerEmail: "private@example.com",
      paymentMetadata: { amount: 2500, reference: "mock-payment-ref" }
    }],
    clientIp: "198.51.100.9",
    internalNotes: "private diagnostic notes",
    headers: { authorization: "Bearer mock-secret" },
    payment: { status: "paid", reference: "mock-payment-ref" },
    serviceRoleKey: "mock-service-role-secret"
  };

  const sanitized = sanitizePublicAuditReport(report);

  assert.deepEqual(Object.keys(sanitized).sort(), [
    "finalUrl", "fetchedAt", "metrics", "opportunities", "scores", "strategy", "url"
  ]);
  assert.deepEqual(Object.keys(sanitized.scores[0]).sort(), [
    "key", "label", "rating", "ratingLabel", "value"
  ]);
  assert.deepEqual(Object.keys(sanitized.metrics[0]).sort(), ["key", "label", "value"]);
  assert.deepEqual(Object.keys(sanitized.opportunities[0]).sort(), [
    "description", "displayValue", "id", "title"
  ]);
  assert.equal(JSON.stringify(sanitized).includes("mock-secret"), false);
  assert.equal(JSON.stringify(sanitized).includes("mock-payment-ref"), false);
  assert.equal(JSON.stringify(sanitized).includes("private@example.com"), false);
  assert.equal(JSON.stringify(sanitized).includes("198.51.100.9"), false);
});

test("public audit report sanitizer bounds arrays and rejects invalid shapes", () => {
  const report = sanitizePublicAuditReport({
    url: "x".repeat(3000),
    strategy: "unexpected",
    scores: Array.from({ length: 10 }, (_, i) => ({
      key: String(i), label: "Score", value: i, rating: "good", ratingLabel: "Good"
    })),
    metrics: Array.from({ length: 20 }, (_, i) => ({
      key: String(i), label: "Metric", value: "1 ms"
    })),
    opportunities: Array.from({ length: 20 }, (_, i) => ({
      id: String(i), title: "Opportunity", displayValue: "", description: ""
    })),
    extra: "not public"
  });

  assert.equal(report.url.length, 2048);
  assert.equal(report.strategy, "mobile");
  assert.equal(report.scores.length, 4);
  assert.equal(report.metrics.length, 12);
  assert.equal(report.opportunities.length, 8);
  assert.equal(Object.hasOwn(report, "extra"), false);
  assert.equal(sanitizePublicAuditReport(null).scores.length, 0);
  assert.equal(sanitizePublicAuditReport("invalid").opportunities.length, 0);
});
