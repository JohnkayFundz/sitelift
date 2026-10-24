import { json, supabaseAdmin } from "../_lib/server.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const text = (value, maxLength = 500) =>
  typeof value === "string" ? value.slice(0, maxLength) : "";

function publicScore(score) {
  if (!score || typeof score !== "object" || Array.isArray(score)) return null;
  return {
    key: text(score.key, 80),
    label: text(score.label, 120),
    value: typeof score.value === "number" && Number.isFinite(score.value) ? score.value : null,
    rating: text(score.rating, 40),
    ratingLabel: text(score.ratingLabel, 80)
  };
}

function publicMetric(metric) {
  if (!metric || typeof metric !== "object" || Array.isArray(metric)) return null;
  return {
    key: text(metric.key, 80),
    label: text(metric.label, 120),
    value: text(metric.value, 120)
  };
}

function publicOpportunity(opportunity) {
  if (!opportunity || typeof opportunity !== "object" || Array.isArray(opportunity)) return null;
  return {
    id: text(opportunity.id, 120),
    title: text(opportunity.title, 180),
    displayValue: text(opportunity.displayValue, 120),
    description: text(opportunity.description, 500)
  };
}

/**
 * Project stored audit JSON onto the intentionally public report contract.
 * Never return arbitrary keys from a database JSON payload.
 */
export function sanitizePublicAuditReport(report) {
  const source = report && typeof report === "object" && !Array.isArray(report) ? report : {};
  return {
    url: text(source.url, 2048),
    finalUrl: text(source.finalUrl, 2048),
    strategy: ["mobile", "desktop"].includes(source.strategy) ? source.strategy : "mobile",
    fetchedAt: text(source.fetchedAt, 80),
    scores: Array.isArray(source.scores) ? source.scores.slice(0, 4).map(publicScore).filter(Boolean) : [],
    metrics: Array.isArray(source.metrics) ? source.metrics.slice(0, 12).map(publicMetric).filter(Boolean) : [],
    opportunities: Array.isArray(source.opportunities) ? source.opportunities.slice(0, 8).map(publicOpportunity).filter(Boolean) : []
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return json(res, 405, { error: "Method not allowed" }); }
  const id = req.query?.id;
  if (typeof id !== "string" || !UUID.test(id)) return json(res, 400, { error: "Invalid report ID" });
  try {
    const { data, error } = await supabaseAdmin().from("audits").select("id,target_url,final_url,strategy,report,created_at").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return json(res, 404, { error: "Audit report not found" });
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return json(res, 200, { ...sanitizePublicAuditReport(data.report), auditId: data.id, reportUrl: "/audit/" + data.id });
  } catch (error) { console.error("Audit report lookup failed", error?.message); return json(res, 503, { error: "Report service temporarily unavailable" }); }
}
