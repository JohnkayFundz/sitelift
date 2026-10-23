import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertSupabaseEnvironmentSafe } from "../api/_lib/environment.js";

const productionUrl = "https://jnuqpijilwmhefbtjimx.supabase.co";

test("Preview refuses Supabase access when configured for the SiteLift production project", () => {
  assert.throws(
    () => assertSupabaseEnvironmentSafe({ vercelEnv: "preview", supabaseUrl: productionUrl }),
    /Preview.*production database/
  );
});

test("production and local environments are not blocked by the Preview guard", () => {
  assert.doesNotThrow(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "production",
    supabaseUrl: productionUrl
  }));
  assert.doesNotThrow(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "development",
    supabaseUrl: productionUrl
  }));
});

test("Preview can use a different Supabase project", () => {
  assert.doesNotThrow(() => assertSupabaseEnvironmentSafe({
    vercelEnv: "preview",
    supabaseUrl: "https://independent-test-project.supabase.co"
  }));
});

test("Preview fails closed when its Supabase URL is malformed", () => {
  assert.throws(
    () => assertSupabaseEnvironmentSafe({ vercelEnv: "preview", supabaseUrl: "not a URL" }),
    /configured URL is invalid/
  );
});

test("PageSpeed persistence checks the Preview database guard before creating a Supabase client", () => {
  const source = readFileSync(new URL("../api/pagespeed.js", import.meta.url), "utf8");
  const factory = source.match(/function getSupabase\(\) \{([\s\S]*?)\n\}/)?.[1];

  assert.ok(factory, "expected a getSupabase factory in api/pagespeed.js");
  assert.match(source, /import \{ assertSupabaseEnvironmentSafe \} from "\.\/_lib\/environment\.js";/);
  const guardIndex = factory.indexOf("assertSupabaseEnvironmentSafe({ supabaseUrl: url })");
  const clientIndex = factory.indexOf("createClient(url, key,");

  assert.notEqual(guardIndex, -1, "PageSpeed must call the Preview database guard");
  assert.notEqual(clientIndex, -1, "PageSpeed must create its Supabase client");
  assert.ok(guardIndex < clientIndex, "the Preview database guard must run before client creation");

  const handler = source.slice(source.indexOf("export default async function handler"));
  const preflightIndex = handler.indexOf("assertSupabaseEnvironmentSafe();");
  const rateLimitIndex = handler.indexOf("getLimiter().limit(clientIp(req))");
  const pageSpeedFetchIndex = handler.indexOf("await fetch(endpoint");

  assert.notEqual(preflightIndex, -1, "PageSpeed must check environment safety before processing an audit");
  assert.ok(preflightIndex < rateLimitIndex, "unsafe Preview requests must be rejected before rate-limit usage");
  assert.ok(preflightIndex < pageSpeedFetchIndex, "unsafe Preview requests must be rejected before calling Google PageSpeed");
});

test("server Supabase client refuses the production project in Vercel Preview before connecting", async () => {
  const { supabaseAdmin } = await import("../api/_lib/server.js");
  const previous = {
    vercelEnv: process.env.VERCEL_ENV,
    supabaseUrl: process.env.SUPABASE_URL,
    viteSupabaseUrl: process.env.VITE_SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  process.env.VERCEL_ENV = "preview";
  process.env.SUPABASE_URL = productionUrl;
  delete process.env.VITE_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-not-a-real-key";

  try {
    assert.throws(() => supabaseAdmin(), /Refusing Supabase access from Vercel Preview/);
  } finally {
    for (const [key, value] of Object.entries({
      VERCEL_ENV: previous.vercelEnv,
      SUPABASE_URL: previous.supabaseUrl,
      VITE_SUPABASE_URL: previous.viteSupabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: previous.serviceRoleKey
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
