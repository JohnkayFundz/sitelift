import { json, processVerifiedPaystackPayment, supabaseAdmin } from "../_lib/server.js";
export default async function handler(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return json(res, 405, { error: "Method not allowed" }); }
  const reference = req.query?.reference;
  const token = req.query?.token;
  if (typeof reference !== "string" || !/^sitelift_[0-9a-f-]{36}_[a-f0-9]{32}$/i.test(reference) ||
      typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token)) {
    return json(res, 403, { error: "A valid download token is required" });
  }
  try {
    const db = supabaseAdmin();
    const { data: authorized, error: authError } = await db.from("audit_payments")
      .select("id,status,token_expires_at")
      .eq("reference", reference)
      .eq("download_token", token)
      .maybeSingle();
    if (authError) throw authError;
    if (!authorized || !authorized.token_expires_at || new Date(authorized.token_expires_at).getTime() <= Date.now()) {
      return json(res, 403, { error: "Download token is invalid or expired" });
    }

    if (authorized.status !== "paid") {
      const recovered = await processVerifiedPaystackPayment(reference);
      if (recovered.status === "not_found") return json(res, 404, { error: "Payment not found" });
      if (recovered.status !== "paid") return json(res, 200, { status: recovered.status, downloadUrl: null });
    }

    const { data: payment, error: paymentError } = await db.from("audit_payments")
      .select("status,pdf_path,download_token,token_expires_at")
      .eq("reference", reference).eq("download_token", token).maybeSingle();
    if (paymentError) throw paymentError;
    if (!payment || payment.status !== "paid" || !payment.pdf_path) {
      return json(res, 200, { status: payment?.status || "pending", downloadUrl: null });
    }
    if (!payment.token_expires_at || new Date(payment.token_expires_at).getTime() <= Date.now()) {
      return json(res, 403, { error: "Download token is invalid or expired" });
    }
    const { data, error: signedError } = await db.storage.from("audit-reports")
      .createSignedUrl(payment.pdf_path, 3600, { download: true });
    if (signedError) throw signedError;
    return json(res, 200, { status: "paid", downloadUrl: data.signedUrl, expiresIn: 3600 });
  } catch (error) {
    console.error("Payment status lookup failed", error?.message);
    return json(res, 503, { error: "Unable to check payment status" });
  }
}
