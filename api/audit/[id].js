import { json, supabaseAdmin } from "../_lib/server.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export default async function handler(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return json(res, 405, { error: "Method not allowed" }); }
  const id = req.query?.id;
  if (typeof id !== "string" || !UUID.test(id)) return json(res, 400, { error: "Invalid report ID" });
  try {
    const { data, error } = await supabaseAdmin().from("audits").select("id,target_url,final_url,strategy,report,created_at").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return json(res, 404, { error: "Audit report not found" });
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return json(res, 200, { ...data.report, auditId: data.id, reportUrl: "/audit/" + data.id });
  } catch (error) { console.error("Audit report lookup failed", error?.message); return json(res, 503, { error: "Report service temporarily unavailable" }); }
}
