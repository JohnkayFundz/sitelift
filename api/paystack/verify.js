import { json, processVerifiedPaystackPayment, supabaseAdmin } from "../_lib/server.js";

const REFERENCE = /^sitelift_[0-9a-f-]{36}_[a-f0-9]{32}$/i;
const TOKEN = /^[a-f0-9]{64}$/i;

export function createPaystackVerifyHandler({
  getSupabaseAdmin = supabaseAdmin,
  processPayment = processVerifiedPaystackPayment
} = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "Method not allowed" });
    }

    const { reference, token } = req.body || {};
    if (typeof reference !== "string" || !REFERENCE.test(reference) ||
        typeof token !== "string" || !TOKEN.test(token)) {
      return json(res, 403, { error: "A valid download token is required" });
    }

    try {
      const db = getSupabaseAdmin();
      const { data: authorized, error: authError } = await db.from("audit_payments")
        .select("status,token_expires_at")
        .eq("reference", reference)
        .eq("download_token", token)
        .maybeSingle();
      if (authError) throw authError;
      if (!authorized) {
        return json(res, 403, { error: "Download token is invalid", reason: "invalid_token" });
      }
      if (!authorized.token_expires_at || new Date(authorized.token_expires_at).getTime() <= Date.now()) {
        return json(res, 403, { error: "Download token is invalid or expired", reason: "expired_token" });
      }

      const result = await processPayment(reference);
      if (result.status === "not_found") return json(res, 404, { error: "Payment not found" });
      if (result.status !== "paid") {
        return json(res, 200, { status: result.status || "pending", downloadUrl: null });
      }

      const { data: payment, error: paymentError } = await db.from("audit_payments")
        .select("status,pdf_path,download_token,token_expires_at")
        .eq("reference", reference)
        .eq("download_token", token)
        .maybeSingle();
      if (paymentError) throw paymentError;
      if (!payment || payment.status !== "paid" || !payment.pdf_path) {
        return json(res, 200, { status: payment?.status || "pending", downloadUrl: null });
      }
      if (!payment.token_expires_at || new Date(payment.token_expires_at).getTime() <= Date.now()) {
        return json(res, 403, { error: "Download token is invalid or expired", reason: "expired_token" });
      }

      const { data, error: signedError } = await db.storage.from("audit-reports")
        .createSignedUrl(payment.pdf_path, 3600, { download: true });
      if (signedError) throw signedError;
      return json(res, 200, { status: "paid", downloadUrl: data.signedUrl, expiresIn: 3600 });
    } catch (error) {
      console.error("Explicit Paystack verification failed", error?.message);
      return json(res, 503, { error: "Unable to verify payment right now" });
    }
  };
}

export default createPaystackVerifyHandler();
