import test from "node:test";
import assert from "node:assert/strict";
import { clientIp, isPublicWebUrl } from "../api/pagespeed.js";

test("accepts public HTTP and HTTPS domain URLs", () => {
  assert.equal(isPublicWebUrl("https://example.com/"), true);
  assert.equal(isPublicWebUrl("http://shop.example.ng/products?sort=new"), true);
});

test("rejects non-web protocols and malformed values", () => {
  assert.equal(isPublicWebUrl("javascript:alert(1)"), false);
  assert.equal(isPublicWebUrl("file:///etc/passwd"), false);
  assert.equal(isPublicWebUrl("not a url"), false);
  assert.equal(isPublicWebUrl(""), false);
});

test("rejects local, reserved, and literal IP destinations", () => {
  for (const url of [
    "http://localhost",
    "http://admin.local",
    "http://service.internal",
    "http://example.test",
    "http://example.invalid",
    "http://192.168.1.1",
    "http://127.0.0.1",
    "http://[::1]/",
    "http://metadata.google.internal"
  ]) {
    assert.equal(isPublicWebUrl(url), false, url);
  }
});

test("rejects embedded credentials, unexpected ports, and oversized URLs", () => {
  assert.equal(isPublicWebUrl("https://user:pass@example.com/"), false);
  assert.equal(isPublicWebUrl("https://example.com:8443/"), false);
  assert.equal(isPublicWebUrl("https://example.com/" + "a".repeat(2050)), false);
});

test("rate-limit identity ignores caller-controlled X-Forwarded-For", () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "198.51.100.99", "x-real-ip": "203.0.113.12" }, socket: { remoteAddress: "127.0.0.1" } }), "203.0.113.12");
  assert.equal(clientIp({ headers: { "x-forwarded-for": "198.51.100.99" }, socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
});
