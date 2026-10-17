import { json, supabaseAdmin } from "../_lib/server.js";
export default async function handler(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return json(res, 405, { error: "Method not allowed" }); }
  const reference = req.query?.reference;
  if (typeof reference !== "string" || !/^sitelift_[0-9a-f-]{36}_[a-f0-9]{32}$/i.test(reference)) return json(res, 400, { error: "Invalid payment reference" });
  try {
    const db = supabaseAdmin();
    const { data: payment, error } = await db.from("audit_payments").select("status,pdf_path,audit_id").eq("reference", reference).maybeSingle();
    if (error) throw error;
    if (!payment) return json(res, 404, { error: "Payment not found" });
    if (payment.status !== "paid" || !payment.pdf_path) return json(res, 200, { status: payment.status, downloadUrl: null });
    const { data, error: signedError } = await db.storage.from("audit-reports").createSignedUrl(payment.pdf_path, 3600, { download: true });
    if (signedError) throw signedError;
    return json(res, 200, { status: "paid", downloadUrl: data.signedUrl, expiresIn: 3600 });
  } catch (error) { console.error("Payment status lookup failed", error?.message); return json(res, 503, { error: "Unable to check payment status" }); }
}
