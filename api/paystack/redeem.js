import { randomBytes } from "node:crypto";
import { json, supabaseAdmin } from "../_lib/server.js";
import {
  clearRedemptionCookie,
  readRedemptionCookie,
  setReportSessionCookie,
  sha256Hex
} from "../_lib/report-download.js";

const REFERENCE = /^sitelift_([0-9a-f-]{36})_[a-f0-9]{32}$/i;
const TOKEN = /^[a-f0-9]{64}$/i;

export function createReportRedemptionHandler({
  getSupabaseAdmin = supabaseAdmin,
  createSessionToken = () => randomBytes(32).toString("hex")
} = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "Method not allowed" });
    }

    const reference = req.body?.reference;
    if (typeof reference !== "string" || !REFERENCE.test(reference)) {
      return json(res, 400, { error: "A valid payment reference is required" });
    }

    const recoveryCode = req.body?.recoveryCode;
    const token = typeof recoveryCode === "string" && TOKEN.test(recoveryCode)
      ? recoveryCode
      : readRedemptionCookie(req, reference);
    if (!token) return json(res, 403, { error: "A valid one-time recovery code is required" });

    try {
      const db = getSupabaseAdmin();
      const { data: authorized, error: authorizationError } = await db.from("audit_payments")
        .select("status,pdf_path,token_expires_at,delivery_blocked")
        .eq("reference", reference)
        .eq("download_token_hash", sha256Hex(token))
        .maybeSingle();
      if (authorizationError) throw authorizationError;
      if (!authorized) return json(res, 403, { error: "One-time code is invalid or already used" });
      if (!authorized.token_expires_at || new Date(authorized.token_expires_at).getTime() <= Date.now()) {
        return json(res, 403, { error: "One-time code has expired" });
      }
      if (authorized.delivery_blocked) {
        return json(res, 403, { error: "Report delivery is temporarily blocked" });
      }

      // Payment fulfillment is exclusively worker-driven. Customer redemption
      // only consumes the one-time authorization after the worker commits paid
      // status and the deterministic private PDF path.
      if (authorized.status !== "paid" || !authorized.pdf_path) {
        return json(res, 200, {
          status: authorized.status || "pending",
          downloadReady: false
        });
      }

      const sessionToken = createSessionToken();
      if (typeof sessionToken !== "string" || !TOKEN.test(sessionToken)) {
        throw new Error("Session token generator returned an invalid value");
      }

      const { data, error } = await db.rpc("redeem_report_download", {
        p_reference: reference,
        p_token_hash: sha256Hex(token),
        p_session_hash: sha256Hex(sessionToken),
        p_now: new Date().toISOString()
      });
      if (error) throw error;
      const redeemed = Array.isArray(data) ? data[0] : data;
      if (!redeemed?.audit_id) {
        return json(res, 403, { error: "This one-time code is invalid, expired, or already used" });
      }

      clearRedemptionCookie(res);
      setReportSessionCookie(res, redeemed.audit_id, sessionToken, 3600);
      return json(res, 200, {
        status: "paid",
        downloadReady: true,
        downloadPath: "/api/reports/" + redeemed.audit_id + "/download"
      });
    } catch (error) {
      console.error("Report redemption failed", error?.message);
      return json(res, 503, { error: "Unable to prepare the secure report session" });
    }
  };
}

export default createReportRedemptionHandler();
