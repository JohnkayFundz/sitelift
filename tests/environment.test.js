import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertSupabaseEnvironmentSafe } from "../api/_lib/environment.js";

const productionUrl = "https://jnuqpijilwmhefbtjimx.supabase.co";
const stagingUrl = "https://pxlshpoooiuviszdgrzj.supabase.co";

function withEnvironment(values, callback) {
  const keys = Object.keys(values);
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Production accepts only the fixed SiteLift production project", () => {
  assert.doesNotThrow(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "production",
    nodeEnv: "production",
    supabaseUrl: productionUrl
  }));
  assert.throws(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "production",
    nodeEnv: "production",
    supabaseUrl: stagingUrl
  }), /does not match the approved project/);
});

test("Preview accepts only the fixed SiteLift staging project", () => {
  assert.doesNotThrow(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "preview",
    nodeEnv: "production",
    supabaseUrl: stagingUrl
  }));
  assert.throws(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "preview",
    nodeEnv: "production",
    supabaseUrl: productionUrl
  }), /does not match the approved project/);
});

test("Local development without VERCEL_ENV accepts only the fixed staging project", () => {
  withEnvironment({
    VERCEL_ENV: undefined,
    NODE_ENV: "development",
    VERCEL: undefined
  }, () => {
    assert.doesNotThrow(() => assertSupabaseEnvironmentSafe({
      supabaseUrl: stagingUrl
    }));
    assert.throws(() => assertSupabaseEnvironmentSafe({
      supabaseUrl: productionUrl
    }), /does not match the approved project/);
  });
});

test("Vercel development is treated as local and is restricted to staging", () => {
  assert.doesNotThrow(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "development",
    nodeEnv: "development",
    supabaseUrl: stagingUrl
  }));
  assert.throws(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "development",
    nodeEnv: "development",
    supabaseUrl: productionUrl
  }), /does not match the approved project/);
});

test("Missing, unknown, and conflicting runtime identities fail closed", () => {
  for (const options of [
    { vercelEnv: undefined, nodeEnv: "production", vercel: undefined, supabaseUrl: stagingUrl },
    { vercelEnv: "staging", nodeEnv: "development", vercel: "1", supabaseUrl: stagingUrl },
    { vercelEnv: "preview ", nodeEnv: "production", vercel: "1", supabaseUrl: stagingUrl },
    { vercelEnv: undefined, nodeEnv: "development", vercel: "1", supabaseUrl: stagingUrl },
    { vercelEnv: "production", nodeEnv: "development", vercel: "1", supabaseUrl: productionUrl },
    { vercelEnv: "preview", nodeEnv: "development", vercel: "1", supabaseUrl: stagingUrl }
  ]) {
    assert.throws(
      () => assertSupabaseEnvironmentSafe(options),
      /environment is missing, unrecognized, or conflicting/
    );
  }
});

test("A caller-supplied preview project reference cannot override the fixed staging identity", () => {
  assert.throws(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "preview",
    nodeEnv: "production",
    supabaseUrl: "https://abcdefghijklmnopqrst.supabase.co",
    approvedPreviewProjectRef: "abcdefghijklmnopqrst"
  }), /does not match the approved project/);
});

test("Supabase URL is mandatory in every execution environment", () => {
  for (const supabaseUrl of ["", "   "]) {
    assert.throws(() => assertSupabaseEnvironmentSafe({
      vercelEnv: "preview",
      nodeEnv: "production",
      supabaseUrl
    }), /Supabase URL is missing/);
  }

  withEnvironment({ SUPABASE_URL: undefined }, () => {
    assert.throws(() => assertSupabaseEnvironmentSafe({
      vercelEnv: "preview",
      nodeEnv: "production"
    }), /Supabase URL is missing/);
  });
});

test("Supabase URL must be an exact HTTPS project origin", () => {
  for (const supabaseUrl of [
    "not a URL",
    "http://pxlshpoooiuviszdgrzj.supabase.co",
    "https://user:password@pxlshpoooiuviszdgrzj.supabase.co",
    "https://pxlshpoooiuviszdgrzj.supabase.co:8443",
    "https://pxlshpoooiuviszdgrzj.supabase.co/extra",
    "https://pxlshpoooiuviszdgrzj.supabase.co/?query=1",
    "https://pxlshpoooiuviszdgrzj.supabase.co/#fragment",
    "https://pxlshpoooiuviszdgrzj.supabase.co.evil.example"
  ]) {
    assert.throws(
      () => assertSupabaseEnvironmentSafe({
        vercelEnv: "preview",
        nodeEnv: "production",
        supabaseUrl
      }),
      /configured Supabase URL|configured Supabase host/
    );
  }
});

test("Server Supabase client requires server-only SUPABASE_URL and checks it before client creation", async () => {
  const { supabaseAdmin } = await import("../api/_lib/server.js");
  withEnvironment({
    VERCEL_ENV: "preview",
    NODE_ENV: "production",
    VERCEL: "1",
    SUPABASE_URL: productionUrl,
    VITE_SUPABASE_URL: stagingUrl,
    SUPABASE_SERVICE_ROLE_KEY: "unit-test-not-a-real-key"
  }, () => {
    assert.throws(
      () => supabaseAdmin(),
      /does not match the approved project/
    );

    delete process.env.SUPABASE_URL;
    assert.throws(
      () => supabaseAdmin(),
      /Missing Supabase server configuration/
    );
  });
});

test("PageSpeed checks environment safety before rate-limit and external API work", () => {
  const source = readFileSync(new URL("../api/pagespeed.js", import.meta.url), "utf8");
  const factoryStart = source.indexOf("function getSupabase() {");
  const factoryEnd = source.indexOf("\n}", factoryStart);
  const factory = source.slice(factoryStart, factoryEnd);

  assert.notEqual(factoryStart, -1, "expected a getSupabase factory in api/pagespeed.js");
  assert.ok(source.includes("const url = process.env.SUPABASE_URL;"));
  assert.ok(!source.includes("process.env.VITE_SUPABASE_URL"));
  assert.ok(source.includes('import { assertSupabaseEnvironmentSafe } from "./_lib/environment.js";'));

  const guardIndex = factory.indexOf("assertSupabaseEnvironmentSafe({ supabaseUrl: url })");
  const clientIndex = factory.indexOf("createClient(url, key,");
  assert.notEqual(guardIndex, -1);
  assert.notEqual(clientIndex, -1);
  assert.ok(guardIndex < clientIndex);

  const handler = source.slice(source.indexOf("export default async function handler"));
  const preflightIndex = handler.indexOf("assertSupabaseEnvironmentSafe();");
  const rateLimitIndex = handler.indexOf("getLimiter().limit(clientIp(req))");
  const pageSpeedFetchIndex = handler.indexOf("await fetch(endpoint");
  assert.notEqual(preflightIndex, -1);
  assert.ok(preflightIndex < rateLimitIndex);
  assert.ok(preflightIndex < pageSpeedFetchIndex);
});
