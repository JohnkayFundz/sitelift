import { json, supabaseAdmin } from "../../../_lib/server.js";
import {
  clearReportSessionCookie,
  readCookie,
  reportSessionCookieName,
  sha256Hex
} from "../../../_lib/report-download.js";

const AUDIT_ID = /^[0-9a-f-]{36}$/i;
const TOKEN = /^[a-f0-9]{64}$/i;

export function createReportDownloadHandler({ getSupabaseAdmin = supabaseAdmin } = {}) {
  return async function handler(req, res) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { error: "Method not allowed" });
    }

    const auditId = req.query?.auditId;
    if (typeof auditId !== "string" || !AUDIT_ID.test(auditId)) {
      return json(res, 400, { error: "A valid report identifier is required" });
    }

    const sessionToken = readCookie(req, reportSessionCookieName(auditId));
    if (!TOKEN.test(sessionToken)) {
      clearReportSessionCookie(res, auditId);
      return json(res, 403, { error: "A valid report session is required" });
    }

    try {
      const db = getSupabaseAdmin();
      const { data, error } = await db.rpc("authorize_report_download", {
        p_audit_id: auditId,
        p_session_hash: sha256Hex(sessionToken),
        p_now: new Date().toISOString()
      });
      if (error) throw error;
      const authorized = Array.isArray(data) ? data[0] : data;
      if (!authorized?.pdf_path) {
        clearReportSessionCookie(res, auditId);
        return json(res, 403, { error: "Report access is unavailable or has expired" });
      }

      const { data: file, error: fileError } = await db.storage
        .from("audit-reports")
        .download(authorized.pdf_path);
      if (fileError || !file) throw fileError || new Error("Report file is unavailable");

      const buffer = Buffer.from(await file.arrayBuffer());
      res.status(200);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="sitelift-report.pdf"');
      res.setHeader("Content-Length", String(buffer.length));
      res.setHeader("Cache-Control", "no-store, private, max-age=0");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      return res.send(buffer);
    } catch (error) {
      console.error("Secure report delivery failed", error?.message);
      return json(res, 503, { error: "Unable to deliver the report right now" });
    }
  };
}

export default createReportDownloadHandler();
