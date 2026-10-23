import { createHmac, timingSafeEqual } from "node:crypto";
import { json, processVerifiedPaystackPayment } from "../_lib/server.js";
export const config = { api: { bodyParser: false }, maxDuration: 60 };
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > MAX_WEBHOOK_BODY_BYTES) throw new Error("Webhook body too large");
    return req.body;
  }
  if (typeof req.body === "string") {
    const body = Buffer.from(req.body);
    if (body.length > MAX_WEBHOOK_BODY_BYTES) throw new Error("Webhook body too large");
    return body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_WEBHOOK_BODY_BYTES) throw new Error("Webhook body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
export function validSignature(raw, signature, secret) {
  if (typeof signature !== "string" || !/^[a-f0-9]{128}$/i.test(signature)) return false;
  const expected = createHmac("sha512", secret).update(raw).digest(); const supplied = Buffer.from(signature, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
export function createPaystackWebhookHandler({ processPayment = processVerifiedPaystackPayment } = {}) {
  return async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, 405, { error: "Method not allowed" }); }
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return json(res, 503, { error: "Webhook is not configured" });
  let raw; try { raw = await rawBody(req); } catch { return json(res, 400, { error: "Invalid webhook body" }); }
  if (!validSignature(raw, req.headers["x-paystack-signature"], secret)) return json(res, 401, { error: "Invalid webhook signature" });
  let event; try { event = JSON.parse(raw.toString("utf8")); } catch { return json(res, 400, { error: "Invalid JSON" }); }
  if (event.event !== "charge.success" || !event.data?.reference) return json(res, 200, { received: true });
  try {
    const result = await processPayment(String(event.data.reference));
    if (result.status === "not_found") return json(res, 404, { error: "Payment reference not found" });
    if (result.status === "processing") {
      // A concurrent delivery owns the atomic processing claim; acknowledge the
      // retry so Paystack does not create a webhook retry storm.
      return json(res, 200, { received: true, duplicate: true, processing: true });
    }
    if (result.status !== "paid") return json(res, 400, { error: "Transaction is not confirmed as paid" });
    return json(res, 200, { received: true, duplicate: Boolean(result.duplicate) });
  } catch (error) {
    console.error("Paystack webhook processing failed", error?.message);
    return json(res, 500, { error: "Webhook processing failed; provider may retry" });
  }
  };
}

export default createPaystackWebhookHandler();
