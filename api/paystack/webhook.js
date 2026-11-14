import { createHmac, timingSafeEqual } from "node:crypto";
import { json, supabaseAdmin } from "../_lib/server.js";

export const config = { api: { bodyParser: false }, maxDuration: 10 };
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
  const expected = createHmac("sha512", secret).update(raw).digest();
  const supplied = Buffer.from(signature, "hex");
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
}

function rpcRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

export function createPaystackWebhookHandler({
  getSupabaseAdmin = supabaseAdmin
} = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "Method not allowed" });
    }

    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return json(res, 503, { error: "Webhook is not configured" });

    let raw;
    try {
      raw = await rawBody(req);
    } catch {
      return json(res, 400, { error: "Invalid webhook body" });
    }

    if (!validSignature(raw, req.headers?.["x-paystack-signature"], secret)) {
      return json(res, 401, { error: "Invalid webhook signature" });
    }

    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      return json(res, 400, { error: "Invalid JSON" });
    }

    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return json(res, 400, { error: "Invalid webhook event" });
    }

    if (event.event !== "charge.success") {
      return json(res, 200, { received: true });
    }

    const reference = event.data?.reference;
    if (typeof reference !== "string" || reference.length < 1 || reference.length > 200) {
      return json(res, 400, { error: "Invalid payment reference" });
    }

    try {
      const db = getSupabaseAdmin();
      const { data, error } = await db.rpc("enqueue_payment_recovery_job", {
        p_reference: reference
      });
      if (error) throw error;

      const accepted = rpcRow(data);
      if (accepted?.accepted !== true) {
        // Never acknowledge an event until the durable queue has accepted it.
        // Provider retry is the recovery path for a transient DB failure/state race.
        return json(res, 503, { error: "Payment recovery could not be durably queued" });
      }

      return json(res, 200, {
        received: true,
        queued: true,
        duplicate: Boolean(accepted.duplicate),
        alreadyPaid: Boolean(accepted.already_paid)
      });
    } catch (error) {
      console.error("Paystack webhook enqueue failed", error?.message);
      return json(res, 503, { error: "Payment recovery could not be durably queued" });
    }
  };
}

export default createPaystackWebhookHandler();
