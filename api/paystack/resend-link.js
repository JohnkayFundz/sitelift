import { randomBytes } from "node:crypto";
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import { json, supabaseAdmin } from "../_lib/server.js";

const GENERIC_MESSAGE = "If the reference and email match a paid record, a fresh download link has been sent to your email.";

function normalizedEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function requestIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0].trim().slice(0, 100);
  return String(req.socket?.remoteAddress || "unknown").slice(0, 100);
}

export function createResendLinkHandler({
  getSupabaseAdmin = supabaseAdmin,
  createRateLimiter = () => {
    const redis = Redis.fromEnv();
    return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, "10 m"), prefix: "sitelift:resend-link" });
  },
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
      /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email.trim());

    const mailKey = process.env.RESEND_API_KEY;
    const mailFrom = process.env.RESEND_FROM_EMAIL;
    if (!mailKey || !mailFrom) {
      console.error("Secure download recovery is not configured: RESEND_API_KEY/RESEND_FROM_EMAIL missing");
      return json(res, 503, { error: "Secure link recovery is temporarily unavailable. Please try again later." });
    }

    try {
      const limiter = createRateLimiter();
      const rate = await limiter.limit(requestIp(req));
      if (!rate.success) return json(res, 200, { message: GENERIC_MESSAGE });

      if (validReference && validEmail) {
        const db = getSupabaseAdmin();
        const { data: payment, error } = await db.from("audit_payments")
          .select("id,audit_id,reference,customer_email,status,pdf_path,download_token,token_expires_at")
          .eq("reference", reference)
          .maybeSingle();
        if (error) throw error;

        const emailMatches = payment && normalizedEmail(payment.customer_email) === normalizedEmail(email);
        const isExpired = payment && (!payment.token_expires_at ||
          new Date(payment.token_expires_at).getTime() <= now());

        if (payment && emailMatches && payment.status === "paid" && payment.pdf_path && isExpired) {
          const newToken = createToken();
          const expiresAt = new Date(now() + 24 * 60 * 60 * 1000).toISOString();
          let update = db.from("audit_payments").update({
            download_token: newToken,
            token_expires_at: expiresAt
          }).eq("id", payment.id).eq("status", "paid");
          update = payment.download_token
            ? update.eq("download_token", payment.download_token)
            : update.is("download_token", null);
          update = payment.token_expires_at
            ? update.eq("token_expires_at", payment.token_expires_at)
            : update.is("token_expires_at", null);

          const { data: rotated, error: rotateError } = await update.select("id").maybeSingle();
          if (rotateError) throw rotateError;

          // Conditional rotation makes concurrent requests single-winner.
          if (rotated) {
            const origin = process.env.APP_BASE_URL || "https://sitelift.vercel.app";
            const link = new URL("/audit/" + payment.audit_id, origin);
            link.searchParams.set("payment", "return");
            link.searchParams.set("reference", payment.reference);
            link.searchParams.set("token", newToken);

            const delivery = await fetchImpl("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                Authorization: "Bearer " + mailKey,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                from: mailFrom,
                to: [payment.customer_email],
                subject: "Your secure SiteLift report download link",
                text: "Your secure SiteLift PDF report link is ready. This link expires in 24 hours: " + link.toString(),
                html: "<p>Your secure SiteLift PDF report link is ready.</p><p><a href=\"" +
                  link.toString() + "\">Download your report</a></p><p>This link expires in 24 hours. If you did not request this email, you can ignore it.</p>"
              }),
              signal: AbortSignal.timeout(15000)
            });

            if (!delivery.ok) {
              const { error: rollbackError } = await db.from("audit_payments")
                .update({
                  download_token: payment.download_token,
                  token_expires_at: payment.token_expires_at
                }).eq("id", payment.id).eq("download_token", newToken);
              if (rollbackError) console.error("Download token rollback failed", rollbackError.message);
              console.error("SiteLift recovery email delivery failed", delivery.status);
              throw new Error("Recovery email delivery failed");
            }
          }
        }
      }

      return json(res, 200, { message: GENERIC_MESSAGE });
    } catch (error) {
      console.error("Secure download recovery failed", error?.message);
      return json(res, 503, { error: "Secure link recovery is temporarily unavailable. Please try again later." });
    }
  };
}

export default createResendLinkHandler();
