import test from "node:test";
import assert from "node:assert/strict";
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
