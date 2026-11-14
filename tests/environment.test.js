import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertSupabaseEnvironmentSafe } from "../api/_lib/environment.js";

const productionUrl = "https://jnuqpijilwmhefbtjimx.supabase.co";
const stagingUrl = "https://pxlshpoooiuviszdgrzj.supabase.co";

test("Production accepts only the fixed SiteLift production project", () => {
  assert.doesNotThrow(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "production",
    supabaseUrl: productionUrl
  }));
  assert.throws(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "production",
    supabaseUrl: stagingUrl
  }), /does not match the approved project/);
});

test("Preview accepts only the fixed SiteLift staging project", () => {
  assert.doesNotThrow(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "preview",
    supabaseUrl: stagingUrl
  }));
  assert.throws(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "preview",
    supabaseUrl: productionUrl
  }), /does not match the approved project/);
});

test("Local development accepts only the fixed SiteLift staging project", () => {
  assert.doesNotThrow(() => assertSupabaseEnvironmentSafe({
    vercelEnv: undefined,
    nodeEnv: "development",
    vercel: undefined,
    supabaseUrl: stagingUrl
  }));
  assert.throws(() => assertSupabaseEnvironmentSafe({
    vercelEnv: undefined,
    nodeEnv: "development",
    vercel: undefined,
    supabaseUrl: productionUrl
  }), /does not match the approved project/);
});

test("Vercel development is treated as local and is restricted to staging", () => {
  assert.doesNotThrow(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "development",
    supabaseUrl: stagingUrl
  }));
  assert.throws(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "development",
    supabaseUrl: productionUrl
  }), /does not match the approved project/);
});

test("Missing, unknown, and conflicting runtime identities fail closed", () => {
  for (const options of [
    { vercelEnv: undefined, nodeEnv: "production", vercel: undefined, supabaseUrl: stagingUrl },
    { vercelEnv: "staging", nodeEnv: "development", vercel: "1", supabaseUrl: stagingUrl },
    { vercelEnv: "preview ", nodeEnv: "production", vercel: "1", supabaseUrl: stagingUrl },
    { vercelEnv: undefined, nodeEnv: "development", vercel: "1", supabaseUrl: stagingUrl }
  ]) {
    assert.throws(
      () => assertSupabaseEnvironmentSafe(options),
      /environment is missing or unrecognized/
    );
  }
});

test("A caller-supplied preview project reference cannot override the fixed staging identity", () => {
  assert.throws(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "preview",
    supabaseUrl: "https://abcdefghijklmnopqrst.supabase.co",
    approvedPreviewProjectRef: "abcdefghijklmnopqrst"
  }), /does not match the approved project/);
});

test("Supabase URL is mandatory in every execution environment", () => {
  for (const supabaseUrl of [undefined, "", "   "]) {
    assert.throws(() => assertSupabaseEnvironmentSafe({
      vercelEnv: "preview",
      supabaseUrl
    }), /Supabase URL is missing/);
  }
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
        supabaseUrl
      }),
      /configured Supabase URL|configured Supabase host/
    );
  }
});

test("Server Supabase client requires server-only SUPABASE_URL and checks it before client creation", async () => {
  const { supabaseAdmin } = await import("../api/_lib/server.js");
  const previous = {
    vercelEnv: process.env.VERCEL_ENV,
    nodeEnv: process.env.NODE_ENV,
    vercel: process.env.VERCEL,
    supabaseUrl: process.env.SUPABASE_URL,
    viteSupabaseUrl: process.env.VITE_SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  };

  try {
    process.env.VERCEL_ENV = "preview";
    process.env.NODE_ENV = "production";
    process.env.VERCEL = "1";
    process.env.SUPABASE_URL = productionUrl;
    process.env.VITE_SUPABASE_URL = stagingUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-not-a-real-key";

    assert.throws(
      () => supabaseAdmin(),
      /does not match the approved project/
    );

    delete process.env.SUPABASE_URL;
    assert.throws(
      () => supabaseAdmin(),
      /Missing Supabase server configuration/
    );
  } finally {
    for (const [key, value] of Object.entries({
      VERCEL_ENV: previous.vercelEnv,
      NODE_ENV: previous.nodeEnv,
      VERCEL: previous.vercel,
      SUPABASE_URL: previous.supabaseUrl,
      VITE_SUPABASE_URL: previous.viteSupabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: previous.serviceRoleKey
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("PageSpeed checks environment safety before rate-limit and external API work", () => {
  const source = readFileSync(new URL("../api/pagespeed.js", import.meta.url), "utf8");
  const factory = source.match(/function getSupabase\\(\\) \\{([\\s\\S]*?)\\n\\}/)?.[1];

  assert.ok(factory, "expected a getSupabase factory in api/pagespeed.js");
  assert.match(source, /const url = process\\.env\\.SUPABASE_URL;/);
  assert.doesNotMatch(source, /process\\.env\\.VITE_SUPABASE_URL/);
  assert.match(source, /import \\{ assertSupabaseEnvironmentSafe \\} from "\.\\/_lib\\/environment\\.js";/);

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
