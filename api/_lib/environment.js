const PRODUCTION_PROJECT_REF = "jnuqpijilwmhefbtjimx";

export function assertSupabaseEnvironmentSafe({
  vercelEnv = process.env.VERCEL_ENV,
  supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
} = {}) {
  if (vercelEnv !== "preview" || !supabaseUrl) return;

  let hostname;
  try {
    hostname = new URL(supabaseUrl).hostname.toLowerCase();
  } catch {
    throw new Error("Refusing Supabase access in Preview because the configured URL is invalid");
  }

  if (hostname === PRODUCTION_PROJECT_REF + ".supabase.co") {
    throw new Error("Refusing Supabase access from Vercel Preview because it targets the SiteLift production database");
  }
}
