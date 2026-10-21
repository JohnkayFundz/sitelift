import { json, processVerifiedPaystackPayment, supabaseAdmin } from "../_lib/server.js";
export default async function handler(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return json(res, 405, { error: "Method not allowed" }); }
  const reference = req.query?.reference;
  if (typeof reference !== "string" || !/^sitelift_[0-9a-f-]{36}_[a-f0-9]{32}$/i.test(reference)) return json(res, 400, { error: "Invalid payment reference" });
  try {
    const db = supabaseAdmin();
    const { data: existing, error: lookupError } = await db.from("audit_payments")
      .select("status,pdf_path")
      .eq("reference", reference).maybeSingle();
    if (lookupError) throw lookupError;
    if (!existing) return json(res, 404, { error: "Payment not found" });

    // Recover successful payments when the provider webhook was not delivered.
    if (existing.status !== "paid" || !existing.pdf_path) {
      const recovered = await processVerifiedPaystackPayment(reference);
      if (recovered.status === "not_found") return json(res, 404, { error: "Payment not found" });
      if (recovered.status !== "paid") return json(res, 200, { status: recovered.status, downloadUrl: null });
    }

    const { data: payment, error: paymentError } = await db.from("audit_payments")
      .select("status,pdf_path")
      .eq("reference", reference).maybeSingle();
    if (paymentError) throw paymentError;
    if (!payment || payment.status !== "paid" || !payment.pdf_path) {
      return json(res, 200, { status: payment?.status || "pending", downloadUrl: null });
    }
    const { data, error: signedError } = await db.storage.from("audit-reports")
      .createSignedUrl(payment.pdf_path, 3600, { download: true });
    if (signedError) throw signedError;
    return json(res, 200, { status: "paid", downloadUrl: data.signedUrl, expiresIn: 3600 });
  } catch (error) {
    console.error("Payment status lookup failed", error?.message);
    return json(res, 503, { error: "Unable to check payment status" });
  }
}
