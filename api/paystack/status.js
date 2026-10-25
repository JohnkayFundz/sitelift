import { json, supabaseAdmin } from "../_lib/server.js";

const REFERENCE = /^sitelift_[0-9a-f-]{36}_[a-f0-9]{32}$/i;
const TOKEN = /^[a-f0-9]{64}$/i;

export function createPaymentStatusHandler({ getSupabaseAdmin = supabaseAdmin } = {}) {
  return async function handler(req, res) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { error: "Method not allowed" });
    }

    const reference = req.query?.reference;
    const token = req.query?.token;
    if (typeof reference !== "string" || !REFERENCE.test(reference) ||
        typeof token !== "string" || !TOKEN.test(token)) {
      return json(res, 403, { error: "A valid download token is required" });
    }

    try {
      const db = getSupabaseAdmin();
      const { data: payment, error } = await db.from("audit_payments")
        .select("status,pdf_path,token_expires_at")
        .eq("reference", reference)
        .eq("download_token", token)
        .maybeSingle();
      if (error) throw error;
      if (!payment) {
        return json(res, 403, { error: "Download token is invalid", reason: "invalid_token" });
      }
      if (!payment.token_expires_at || new Date(payment.token_expires_at).getTime() <= Date.now()) {
        return json(res, 403, { error: "Download token is invalid or expired", reason: "expired_token" });
      }

      // This GET is intentionally read-only: reconciliation and signed-link
      // creation belong to the explicit POST /api/paystack/verify action.
      return json(res, 200, {
        status: payment.status || "pending",
        downloadReady: payment.status === "paid" && Boolean(payment.pdf_path),
        downloadUrl: null
      });
    } catch (error) {
      console.error("Payment status lookup failed", error?.message);
      return json(res, 503, { error: "Unable to check payment status" });
    }
  };
}

export default createPaymentStatusHandler();
