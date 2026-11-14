import { timingSafeEqual } from "node:crypto";
import { json } from "../_lib/server.js";
import { runPaymentRecoveryBatch } from "../_lib/payment-recovery-worker.js";

export const config = { maxDuration: 60 };

function authorized(req, secret) {
  if (typeof secret !== "string" || secret.length < 32) return false;
  const supplied = req.headers?.authorization;
  if (typeof supplied !== "string" || !supplied.startsWith("Bearer ")) return false;
  const actual = Buffer.from(supplied.slice(7), "utf8");
  const expected = Buffer.from(secret, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createPaymentRecoveryDispatcher({
  runBatch = runPaymentRecoveryBatch
} = {}) {
  return async function handler(req, res) {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return json(res, 405, { error: "Method not allowed" });
    }

    if (!authorized(req, process.env.CRON_SECRET)) {
      return json(res, 401, { error: "Unauthorized" });
    }

    try {
      const summary = await runBatch({ maxJobs: 1, budgetMs: 45_000 });
      return json(res, 200, { ok: true, ...summary });
    } catch (error) {
      console.error("Payment recovery dispatcher failed", error?.message);
      return json(res, 503, { error: "Payment recovery dispatcher unavailable" });
    }
  };
}

export default createPaymentRecoveryDispatcher();
