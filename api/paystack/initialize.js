import { randomBytes } from "node:crypto";
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import { json, supabaseAdmin } from "../_lib/server.js";

const PRICE_KOBO = 250000;
let limiter;

function getLimiter() {
  if (limiter) return limiter;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Payment initialization rate limiter is not configured");
  }
  limiter = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(5, "10 m"),
    prefix: "sitelift:paystack-initialize"
  });
  return limiter;
}

function requestIp(req) {
  const platformIp = req.headers?.["x-real-ip"];
  if (typeof platformIp === "string" && platformIp.length) return platformIp.slice(0, 100);
  return String(req.socket?.remoteAddress || "unknown").slice(0, 100);
}

export function createPaystackInitializeHandler({
  getSupabaseAdmin = supabaseAdmin,
  createRateLimiter = getLimiter,
  fetchImpl = fetch
} = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "Method not allowed" });
    }
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return json(res, 503, { error: "Paid reports are not configured yet" });
    const { auditId, email } = req.body || {};
    if (typeof auditId !== "string" || !/^[0-9a-f-]{36}$/i.test(auditId) ||
        typeof email !== "string" || email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(res, 400, { error: "A valid audit ID and email address are required" });
    }

    try {
      const limiter = createRateLimiter();
      const rate = await limiter.limit(requestIp(req));
      if (!rate.success) {
        res.setHeader("Retry-After", "600");
        return json(res, 429, { error: "Too many checkout attempts. Please try again in a few minutes." });
      }

      const db = getSupabaseAdmin();
      const { data: audit, error: auditError } = await db.from("audits")
        .select("id").eq("id", auditId).maybeSingle();
      if (auditError) throw auditError;
      if (!audit) return json(res, 404, { error: "Audit report not found" });

      // A report can have only one active checkout. The database partial unique
      // index is the concurrency-safe guard; this lookup gives ordinary retries a
      // clear response without calling Paystack again.
      const { data: activePayment, error: activePaymentError } = await db.from("audit_payments")
        .select("id,access_code,reference,status").eq("audit_id", auditId).in("status", ["pending", "processing", "initialization_unknown"])
        .limit(1).maybeSingle();
      if (activePaymentError) throw activePaymentError;
      if (activePayment?.access_code && activePayment?.reference) {
        // Resume the existing provider checkout instead of creating another charge.
        return json(res, 200, {
          authorizationUrl: "https://checkout.paystack.com/" + encodeURIComponent(activePayment.access_code),
          reference: activePayment.reference
        });
      }
      if (activePayment) {
        const message = activePayment.status === "initialization_unknown"
          ? "Checkout initialization needs reconciliation. Please contact support before retrying to avoid duplicate payment attempts."
          : "A checkout is already being initialized for this report. Please wait before trying again.";
        return json(res, 409, { error: message });
      }

      const reference = "sitelift_" + auditId + "_" + randomBytes(16).toString("hex");
      const downloadToken = randomBytes(32).toString("hex");
      const { data: payment, error: paymentError } = await db.from("audit_payments").insert({
        audit_id: auditId, reference, amount: PRICE_KOBO, currency: "NGN",
        customer_email: email, status: "pending", download_token: downloadToken,
        token_expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
      }).select("id").single();
      if (paymentError?.code === "23505") {
        return json(res, 409, { error: "A checkout is already pending for this report. Please wait before trying again." });
      }
      if (paymentError) throw paymentError;

      const origin = process.env.APP_BASE_URL || "https://sitelift.vercel.app";
      const callback = new URL("/audit/" + auditId, origin);
      callback.searchParams.set("payment", "return");
      callback.searchParams.set("reference", reference);
      callback.searchParams.set("token", downloadToken);
      let upstream;
      try {
        upstream = await fetchImpl("https://api.paystack.co/transaction/initialize", {
        method: "POST",
        headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
        body: JSON.stringify({
          email, amount: PRICE_KOBO, currency: "NGN", reference,
          callback_url: callback.toString(),
          metadata: { audit_id: auditId, payment_id: payment.id, product: "unbranded_pdf_audit_report" }
        }),
          signal: AbortSignal.timeout(15000)
        });
      } catch (networkError) {
        // The provider may have created the checkout before the connection timed out.
        // Keep this row active and require reconciliation; never blindly create another.
        const { error: unknownError } = await db.from("audit_payments")
          .update({ status: "initialization_unknown" }).eq("id", payment.id).eq("status", "pending");
        if (unknownError) console.error("Unable to mark checkout outcome unknown", unknownError.message);
        console.error("Paystack initialization outcome is unknown", networkError?.message);
        return json(res, 503, { error: "Checkout status is uncertain. Please contact support before retrying." });
      }
      const result = await upstream.json().catch(() => null);
      if (!upstream.ok || !result?.status || !result.data?.authorization_url) {
        const uncertain = upstream.status >= 500 || !result ||
          /duplicate.*reference|reference.*already exists/i.test(String(result?.message || ""));
        const { error: updateError } = await db.from("audit_payments").update(
          uncertain
            ? { status: "initialization_unknown" }
            : { status: "initialization_failed", download_token: null, token_expires_at: null }
        ).eq("id", payment.id).eq("status", "pending");
        if (updateError) console.error("Unable to record checkout initialization result", updateError.message);
        return json(res, uncertain ? 503 : 502, {
          error: uncertain
            ? "Checkout status is uncertain. Please contact support before retrying."
            : "Payment provider could not initialize checkout"
        });
      }
      const { error: accessCodeError } = await db.from("audit_payments")
        .update({ access_code: result.data.access_code }).eq("id", payment.id);
      if (accessCodeError) {
        // We have the authorization URL, so let the customer continue. The database
        // row stays locked from new initialization attempts until reconciliation.
        const { error: unknownError } = await db.from("audit_payments")
          .update({ status: "initialization_unknown" }).eq("id", payment.id).eq("status", "pending");
        if (unknownError) console.error("Unable to mark checkout outcome unknown", unknownError.message);
        console.error("Paystack access code persistence failed", accessCodeError.message);
      }
      return json(res, 200, { authorizationUrl: result.data.authorization_url, reference });
    } catch (error) {
      console.error("Paystack initialization failed", error?.message);
      return json(res, 503, { error: "Unable to initialize payment right now" });
    }
  };
}

export default createPaystackInitializeHandler();
