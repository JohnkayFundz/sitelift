import { randomBytes } from "node:crypto";
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import { json, supabaseAdmin } from "../_lib/server.js";
import { sha256Hex } from "../_lib/report-download.js";

const GENERIC_MESSAGE = "If the reference and email match a paid record, a one-time recovery code has been sent to the checkout email.";

function normalizedEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function requestIp(req) {
  const platformIp = req.headers?.["x-real-ip"];
  if (typeof platformIp === "string" && platformIp.trim()) return platformIp.trim().slice(0, 100);
  return String(req.socket?.remoteAddress || "unknown").slice(0, 100);
}

export function createResendLinkHandler({
  getSupabaseAdmin = supabaseAdmin,
  createRateLimiter = () => new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(5, "10 m"),
    prefix: "sitelift:resend-link"
  }),
  fetchImpl = fetch,
  now = () => Date.now(),
  createToken = () => randomBytes(32).toString("hex")
} = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "Method not allowed" });
    }

    const { reference, email } = req.body || {};
    const validReference = typeof reference === "string" &&
      /^sitelift_[0-9a-f-]{36}_[a-f0-9]{32}$/i.test(reference);
    const validEmail = typeof email === "string" && email.length <= 254 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
    const mailKey = process.env.RESEND_API_KEY;
    const mailFrom = process.env.RESEND_FROM_EMAIL;
    if (!mailKey || !mailFrom) {
      console.error("Secure recovery is not configured: Resend credentials are missing");
      return json(res, 503, { error: "Secure recovery is temporarily unavailable. Please try again later." });
    }

    try {
      const rate = await createRateLimiter().limit(requestIp(req));
      if (!rate.success) return json(res, 200, { message: GENERIC_MESSAGE });

      if (validReference && validEmail) {
        const db = getSupabaseAdmin();
        const { data: payment, error } = await db.from("audit_payments")
          .select("id,audit_id,reference,customer_email,status,pdf_path,download_token_hash,token_expires_at,token_redeemed_at,delivery_blocked")
          .eq("reference", reference)
          .maybeSingle();
        if (error) throw error;

        const eligible = payment &&
          normalizedEmail(payment.customer_email) === normalizedEmail(email) &&
          payment.status === "paid" && payment.pdf_path && !payment.delivery_blocked;
        if (eligible) {
          const recoveryCode = createToken();
          if (typeof recoveryCode !== "string" || !/^[a-f0-9]{64}$/i.test(recoveryCode)) {
            throw new Error("Recovery code generator returned an invalid value");
          }
          const expiresAt = new Date(now() + 24 * 60 * 60 * 1000).toISOString();
          let update = db.from("audit_payments").update({
            download_token_hash: sha256Hex(recoveryCode),
            download_token: null,
            token_expires_at: expiresAt,
            token_redeemed_at: null
          }).eq("id", payment.id).eq("status", "paid");
          update = payment.download_token_hash
            ? update.eq("download_token_hash", payment.download_token_hash)
            : update.is("download_token_hash", null);
          update = payment.token_redeemed_at
            ? update.eq("token_redeemed_at", payment.token_redeemed_at)
            : update.is("token_redeemed_at", null);
          const { data: rotated, error: rotateError } = await update.select("id").maybeSingle();
          if (rotateError) throw rotateError;

          if (rotated) {
            const origin = process.env.APP_BASE_URL || "https://sitelift.vercel.app";
            const reportPage = new URL("/audit/" + payment.audit_id, origin);
            reportPage.searchParams.set("payment", "recovery");
            reportPage.searchParams.set("reference", payment.reference);

            const delivery = await fetchImpl("https://api.resend.com/emails", {
              method: "POST",
              headers: { Authorization: "Bearer " + mailKey, "Content-Type": "application/json" },
              body: JSON.stringify({
                from: mailFrom,
                to: [payment.customer_email],
                subject: "Your one-time SiteLift report recovery code",
                text: "Your one-time SiteLift report recovery code is:\n\n" +
                  recoveryCode + "\n\nIt expires in 24 hours and can be used once. Open your report page: " +
                  reportPage.toString() + "\nPayment reference: " + payment.reference +
                  "\nEnter the code on that page. Do not share it. If you did not request this email, ignore it."
              }),
              signal: AbortSignal.timeout(15000)
            });

            if (!delivery.ok) {
              const { error: invalidateError } = await db.from("audit_payments")
                .update({ download_token_hash: null, download_token: null, token_expires_at: null })
                .eq("id", payment.id)
                .eq("download_token_hash", sha256Hex(recoveryCode));
              if (invalidateError) console.error("Recovery-code invalidation failed", invalidateError.message);
              console.error("SiteLift recovery email delivery failed", delivery.status);
              throw new Error("Recovery email delivery failed");
            }
          }
        }
      }

      return json(res, 200, { message: GENERIC_MESSAGE });
    } catch (error) {
      console.error("Secure report recovery failed", error?.message);
      return json(res, 503, { error: "Secure recovery is temporarily unavailable. Please try again later." });
    }
  };
}

export default createResendLinkHandler();
