import { timingSafeEqual } from "node:crypto";
import { json } from "../_lib/server.js";
import { processPendingChecklistDeliveries } from "../_lib/delivery.js";

/** @param {unknown} authorization */
function authorized(authorization) {
  const secret = process.env.CRON_SECRET;
  if (!secret || typeof authorization !== "string") return false;
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return false;
  const supplied = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * A trusted scheduler may invoke this route with GET and an Authorization: Bearer CRON_SECRET
 * header. Keep the endpoint private; never return provider or database error text.
 * @param {{ processJobs?: typeof processPendingChecklistDeliveries }} [dependencies]
 */
export function createDeliveryCronHandler({ processJobs = processPendingChecklistDeliveries } = {}) {
  return async function handler(req, res) {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return json(res, 405, { error: "Method not allowed" });
    }
    if (!process.env.CRON_SECRET) {
      return json(res, 503, { error: "Delivery worker is not configured." });
    }
    if (!authorized(req.headers?.authorization)) {
      return json(res, 401, { error: "Unauthorized." });
    }
    try {
      const results = await processJobs({ limit: 3 });
      const summary = results.reduce((acc, result) => {
        const status = ["sent", "retryable", "failed", "lost_claim"].includes(result.status)
          ? result.status : "other";
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, {});
      return json(res, 200, { success: true, processed: results.length, summary });
    } catch {
      console.error("SiteLift delivery cron run failed");
      return json(res, 503, { error: "Delivery worker temporarily unavailable." });
    }
  };
}

export const config = { maxDuration: 60 };
export default createDeliveryCronHandler();
