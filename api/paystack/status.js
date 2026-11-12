import { json, supabaseAdmin } from "../_lib/server.js";
import { readRedemptionCookie, sha256Hex } from "../_lib/report-download.js";

const REFERENCE = /^sitelift_[0-9a-f-]{36}_[a-f0-9]{32}$/i;

export function createPaymentStatusHandler({ getSupabaseAdmin = supabaseAdmin } = {}) {
  return async function handler(req, res) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { error: "Method not allowed" });
    }

    const reference = req.query?.reference;
    if (typeof reference !== "string" || !REFERENCE.test(reference)) {
      return json(res, 400, { error: "A valid payment reference is required" });
    }
    const token = readRedemptionCookie(req, reference);
    if (!token) return json(res, 403, { error: "A valid one-time checkout session is required", reason: "invalid_token" });

    try {
      const db = getSupabaseAdmin();
      const { data: payment, error } = await db.from("audit_payments")
        .select("status,pdf_path,token_expires_at,delivery_blocked")
        .eq("reference", reference)
        .eq("download_token_hash", sha256Hex(token))
        .maybeSingle();
      if (error) throw error;
      if (!payment) {
        return json(res, 403, { error: "One-time checkout session is invalid or already used", reason: "invalid_token" });
      }
      if (!payment.token_expires_at || new Date(payment.token_expires_at).getTime() <= Date.now()) {
        return json(res, 403, { error: "One-time checkout session has expired", reason: "expired_token" });
      }

      // This endpoint is intentionally read-only. It never reconciles a payment,
      // rotates a secret, redeems a token, or creates a download session.
      return json(res, 200, {
        status: payment.status || "pending",
        downloadReady: payment.status === "paid" && Boolean(payment.pdf_path) && !payment.delivery_blocked
      });
    } catch (error) {
      console.error("Payment status lookup failed", error?.message);
      return json(res, 503, { error: "Unable to check payment status" });
    }
  };
}

export default createPaymentStatusHandler();
