import { randomBytes } from "node:crypto";
import { json, supabaseAdmin } from "../_lib/server.js";
const PRICE_KOBO = 250000;
export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, 405, { error: "Method not allowed" }); }
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return json(res, 503, { error: "Paid reports are not configured yet" });
  const { auditId, email } = req.body || {};
  if (typeof auditId !== "string" || !/^[0-9a-f-]{36}$/i.test(auditId) || typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: "A valid audit ID and email address are required" });
  try {
    const db = supabaseAdmin();
    const { data: audit, error: auditError } = await db.from("audits").select("id").eq("id", auditId).maybeSingle();
    if (auditError) throw auditError;
    if (!audit) return json(res, 404, { error: "Audit report not found" });
    const reference = "sitelift_" + auditId + "_" + randomBytes(16).toString("hex");
    const downloadToken = randomBytes(32).toString("hex");
    const { data: payment, error: paymentError } = await db.from("audit_payments").insert({
      audit_id: auditId, reference, amount: PRICE_KOBO, currency: "NGN",
      customer_email: email, status: "pending", download_token: downloadToken,
      token_expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    }).select("id").single();
    if (paymentError) throw paymentError;
    const origin = process.env.APP_BASE_URL || "https://sitelift.vercel.app";
    const callback = new URL("/audit/" + auditId, origin);
    callback.searchParams.set("payment", "return");
    callback.searchParams.set("token", downloadToken);
    const upstream = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST", headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
      body: JSON.stringify({ email, amount: PRICE_KOBO, currency: "NGN", reference, callback_url: callback.toString(), metadata: { audit_id: auditId, payment_id: payment.id, product: "unbranded_pdf_audit_report" } }),
      signal: AbortSignal.timeout(15000)
    });
    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok || !result.status || !result.data?.authorization_url) {
      await db.from("audit_payments").update({ status: "initialization_failed", download_token: null, token_expires_at: null }).eq("id", payment.id);
      return json(res, 502, { error: "Payment provider could not initialize checkout" });
    }
    await db.from("audit_payments").update({ access_code: result.data.access_code }).eq("id", payment.id);
    return json(res, 200, { authorizationUrl: result.data.authorization_url, reference });
  } catch (error) { console.error("Paystack initialization failed", error?.message); return json(res, 503, { error: "Unable to initialize payment right now" }); }
}
