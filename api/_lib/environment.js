const PRODUCTION_PROJECT_REF = "jnuqpijilwmhefbtjimx";
const STAGING_PROJECT_REF = "pxlshpoooiuviszdgrzj";

const PROJECT_REF_BY_ENVIRONMENT = Object.freeze({
  production: PRODUCTION_PROJECT_REF,
  preview: STAGING_PROJECT_REF,
  local: STAGING_PROJECT_REF
});

function resolveExecutionEnvironment({ vercelEnv, nodeEnv, vercel }) {
  if (vercelEnv === "production" || vercelEnv === "preview") {
    return vercelEnv;
  }

  if (vercelEnv === "development") {
    return "local";
  }

  // Plain local Node/Vite development does not always set VERCEL_ENV.
  // Only infer local in a non-Vercel process with an explicit development mode.
  if (
    vercelEnv === undefined &&
    vercel !== "1" &&
    nodeEnv === "development"
  ) {
    return "local";
  }

  throw new Error(
    "Refusing Supabase access because the execution environment is missing or unrecognized"
  );
}

function parseSupabaseProjectRef(supabaseUrl) {
  if (typeof supabaseUrl !== "string" || supabaseUrl.trim() === "") {
    throw new Error("Refusing Supabase access because the Supabase URL is missing");
  }

  if (supabaseUrl.trim() !== supabaseUrl) {
    throw new Error("Refusing Supabase access because the configured Supabase URL is invalid");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(supabaseUrl);
  } catch {
    throw new Error("Refusing Supabase access because the configured Supabase URL is invalid");
  }

  if (
    parsedUrl.protocol !== "https:" ||
    !parsedUrl.hostname ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.port ||
    parsedUrl.pathname !== "/" ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error(
      "Refusing Supabase access because the configured Supabase URL must be an HTTPS project origin"
    );
  }

  const match = parsedUrl.hostname.toLowerCase().match(/^([a-z0-9]{20})\.supabase\.co$/);
  if (!match) {
    throw new Error(
      "Refusing Supabase access because the configured Supabase host is not an approved project endpoint"
    );
  }

  return match[1];
}

export function assertSupabaseEnvironmentSafe({
  vercelEnv = process.env.VERCEL_ENV,
  nodeEnv = process.env.NODE_ENV,
  vercel = process.env.VERCEL,
  supabaseUrl = process.env.SUPABASE_URL
} = {}) {
  const executionEnvironment = resolveExecutionEnvironment({
    vercelEnv,
    nodeEnv,
    vercel
  });
  const actualProjectRef = parseSupabaseProjectRef(supabaseUrl);
  const expectedProjectRef = PROJECT_REF_BY_ENVIRONMENT[executionEnvironment];

  if (actualProjectRef !== expectedProjectRef) {
    throw new Error(
      "Refusing Supabase access because the configured project does not match the approved project for this execution environment"
    );
  }
}
