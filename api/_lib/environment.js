const PRODUCTION_PROJECT_REF = "jnuqpijilwmhefbtjimx";
const STAGING_PROJECT_REF = "pxlshpoooiuviszdgrzj";

const PROJECT_REF_BY_ENVIRONMENT = Object.freeze({
  production: PRODUCTION_PROJECT_REF,
  preview: STAGING_PROJECT_REF,
  local: STAGING_PROJECT_REF
});

function resolveExecutionEnvironment({ vercelEnv, nodeEnv, vercel }) {
  if (vercelEnv === "production" || vercelEnv === "preview") {
    if (vercel !== "1" || nodeEnv !== "production") {
      throw new Error(
        "Refusing Supabase access because the execution environment is missing, unrecognized, or conflicting"
      );
    }
    return vercelEnv;
  }

  if (vercelEnv === "development") {
    if (vercel !== "1" || nodeEnv !== "development") {
      throw new Error(
        "Refusing Supabase access because the execution environment is missing, unrecognized, or conflicting"
      );
    }
    return "local";
  }

  // Local automated tests are isolated to the pinned staging project.
  // This never grants access to the Production project.
  if (
    vercelEnv === undefined &&
    vercel === undefined &&
    nodeEnv === "test"
  ) {
    return "local";
  }

  // Plain local Node/Vite development does not always set VERCEL_ENV.
  // A Vercel runtime must never be inferred to be local when its identity is absent.
  if (
    vercelEnv === undefined &&
    vercel === undefined &&
    nodeEnv === "development"
  ) {
    return "local";
  }

  throw new Error(
    "Refusing Supabase access because the execution environment is missing, unrecognized, or conflicting"
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
