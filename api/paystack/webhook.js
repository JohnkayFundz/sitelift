import { createHmac, timingSafeEqual } from "node:crypto";
import { createAuditPdf, json, supabaseAdmin } from "../_lib/server.js";
export const config = { api: { bodyParser: false }, maxDuration: 60 };
async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error("Webhook body too large"); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
export function validSignature(raw, signature, secret) {
  if (typeof signature !== "string" || !/^[a-f0-9]{128}$/i.test(signature)) return false;
  const expected = createHmac("sha512", secret).update(raw).digest(); const supplied = Buffer.from(signature, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, 405, { error: "Method not allowed" }); }
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return json(res, 503, { error: "Webhook is not configured" });
  let raw; try { raw = await rawBody(req); } catch { return json(res, 400, { error: "Invalid webhook body" }); }
  if (!validSignature(raw, req.headers["x-paystack-signature"], secret)) return json(res, 401, { error: "Invalid webhook signature" });
  let event; try { event = JSON.parse(raw.toString("utf8")); } catch { return json(res, 400, { error: "Invalid JSON" }); }
  if (event.event !== "charge.success" || !event.data?.reference) return json(res, 200, { received: true });
  try {
    const reference = String(event.data.reference);
    const verifyResponse = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference), { headers: { Authorization: "Bearer " + secret }, signal: AbortSignal.timeout(15000) });
    const verified = await verifyResponse.json().catch(() => ({})); const transaction = verified.data;
    if (!verifyResponse.ok || !verified.status || transaction?.status !== "success" || transaction.reference !== reference || transaction.currency !== "NGN") return json(res, 400, { error: "Transaction verification failed" });
    const db = supabaseAdmin();
    const { data: payment, error } = await db.from("audit_payments").select("id,audit_id,amount,status,pdf_path").eq("reference", reference).maybeSingle();
    if (error) throw error;
    if (!payment) return json(res, 404, { error: "Payment reference not found" });
    if (Number(transaction.amount) !== Number(payment.amount)) return json(res, 400, { error: "Transaction amount mismatch" });
    if (payment.status === "paid" && payment.pdf_path) return json(res, 200, { received: true, duplicate: true });
    const { data: audit, error: auditError } = await db.from("audits").select("id,target_url,final_url,strategy,report,created_at").eq("id", payment.audit_id).single();
    if (auditError) throw auditError;
    const pdf = createAuditPdf(audit); const path = audit.id + "/" + reference + ".pdf";
    const { error: uploadError } = await db.storage.from("audit-reports").upload(path, pdf, { contentType: "application/pdf", upsert: false, cacheControl: "3600" });
    if (uploadError && !String(uploadError.message).toLowerCase().includes("already exists")) throw uploadError;
    const { error: updateError } = await db.from("audit_payments").update({ status: "paid", paystack_transaction_id: String(transaction.id), paid_at: new Date().toISOString(), pdf_path: path, webhook_processed_at: new Date().toISOString() }).eq("id", payment.id);
    if (updateError) throw updateError;
    return json(res, 200, { received: true });
  } catch (error) { console.error("Paystack webhook processing failed", error?.message); return json(res, 500, { error: "Webhook processing failed; provider may retry" }); }
}
