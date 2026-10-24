const PRODUCTION_PROJECT_REF = "jnuqpijilwmhefbtjimx";
const SUPABASE_PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

export function assertSupabaseEnvironmentSafe({
  vercelEnv = process.env.VERCEL_ENV,
  supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  approvedPreviewProjectRef = process.env.SUPABASE_PREVIEW_PROJECT_REF
} = {}) {
  // Preserve existing Production and local behavior. The strict allowlist below
  // applies only to Vercel Preview, where production data must never be reachable.
  if (vercelEnv !== "preview") return;

  if (typeof supabaseUrl !== "string" || supabaseUrl.trim() === "") {
    throw new Error("Refusing Supabase access in Preview because the Supabase URL is missing");
  }

  if (supabaseUrl.trim() !== supabaseUrl) {
    throw new Error("Refusing Supabase access in Preview because the configured URL is invalid");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(supabaseUrl);
  } catch {
    throw new Error("Refusing Supabase access in Preview because the configured URL is invalid");
  }

  if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname) {
    throw new Error("Refusing Supabase access in Preview because the configured URL must use HTTPS");
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const productionHostname = PRODUCTION_PROJECT_REF + ".supabase.co";

  if (hostname === productionHostname) {
    throw new Error("Refusing Supabase access from Vercel Preview because it targets the SiteLift production database");
  }

  // No staging project has been verified and approved yet. Until one is bound
  // explicitly, Preview must not connect to any Supabase project.
  if (
    typeof approvedPreviewProjectRef !== "string" ||
    !SUPABASE_PROJECT_REF_PATTERN.test(approvedPreviewProjectRef) ||
    approvedPreviewProjectRef === PRODUCTION_PROJECT_REF
  ) {
    throw new Error("Refusing Supabase access in Preview because no approved staging project reference is configured");
  }

  const approvedHostname = approvedPreviewProjectRef + ".supabase.co";
  if (hostname !== approvedHostname) {
    throw new Error("Refusing Supabase access in Preview because the configured Supabase project is not approved for staging");
  }
}
