import { timingSafeEqual } from "node:crypto";
import { json } from "../_lib/server.js";
import { processPendingCrmSync } from "../_lib/crm-sync.js";

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

/** @param {{ processJobs?: typeof processPendingCrmSync }} [dependencies] */
export function createCrmSyncCronHandler({ processJobs = processPendingCrmSync } = {}) {
  return async function handler(req, res) {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return json(res, 405, { error: "Method not allowed" });
    }
    if (!process.env.CRON_SECRET) {
      return json(res, 503, { error: "CRM sync worker is not configured." });
    }
    if (!authorized(req.headers?.authorization)) {
      return json(res, 401, { error: "Unauthorized." });
    }
    if (!process.env.CRM_API_URL || !process.env.CRM_API_KEY) {
      return json(res, 503, { error: "CRM sync destination is not configured." });
    }
    try {
      const results = await processJobs({ limit: 3 });
      const summary = results.reduce((acc, result) => {
        const status = ["synced", "retryable", "failed", "lost_claim"].includes(result.status)
          ? result.status : "other";
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, {});
      return json(res, 200, { success: true, processed: results.length, summary });
    } catch {
      console.error("SiteLift CRM sync cron run failed");
      return json(res, 503, { error: "CRM sync worker temporarily unavailable." });
    }
  };
}

export const config = { maxDuration: 60 };
export default createCrmSyncCronHandler();
