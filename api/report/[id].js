import { supabaseAdmin } from "../_lib/server.js";
import { sanitizePublicAuditReport } from "../audit/[id].js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);

function renderPage({ title, description, canonical, content }) {
  const image = "https://sitelift.vercel.app/og-sitelift.svg";
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"index,follow,max-image-preview:large\">" +
    "<meta name=\"theme-color\" content=\"#020817\"><title>" + escapeHtml(title) + "</title>" +
    "<meta name=\"description\" content=\"" + escapeHtml(description) + "\"><link rel=\"canonical\" href=\"" + escapeHtml(canonical) + "\">" +
    "<meta property=\"og:type\" content=\"article\"><meta property=\"og:site_name\" content=\"SiteLift by JohnKay Fundz\">" +
    "<meta property=\"og:title\" content=\"" + escapeHtml(title) + "\"><meta property=\"og:description\" content=\"" + escapeHtml(description) + "\">" +
    "<meta property=\"og:url\" content=\"" + escapeHtml(canonical) + "\"><meta property=\"og:image\" content=\"" + image + "\">" +
    "<meta name=\"twitter:card\" content=\"summary_large_image\"><meta name=\"twitter:title\" content=\"" + escapeHtml(title) + "\">" +
    "<meta name=\"twitter:description\" content=\"" + escapeHtml(description) + "\"><meta name=\"twitter:image\" content=\"" + image + "\">" +
    "<link rel=\"stylesheet\" href=\"/report-preview.css\"></head><body><main class=\"report-shell\">" +
    "<a class=\"brand\" href=\"/\">SiteLift <span>by JohnKay Fundz</span></a>" + content +
    "<footer>Automated Lighthouse lab measurements can vary. Scores are not a guarantee of search rankings or business results.</footer></main></body></html>";
}

export function createPublicReportHandler({ getSupabaseAdmin = supabaseAdmin } = {}) {
  return async function handler(req, res) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.status(405).setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.end("Method not allowed");
    }
    const id = req.query?.id;
    if (typeof id !== "string" || !UUID.test(id)) {
      res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(renderPage({ title: "Invalid SiteLift report", description: "The requested report link is invalid.", canonical: "https://sitelift.vercel.app/", content: "<h1>Invalid report link</h1><p>Check the link or run a new audit.</p><a class=\"button\" href=\"/\">Run a free audit</a>" }));
    }
    try {
      const { data, error } = await getSupabaseAdmin().from("audits").select("id,report").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
        return res.end(renderPage({ title: "SiteLift report not found", description: "This website audit report could not be found.", canonical: "https://sitelift.vercel.app/", content: "<h1>Report not found</h1><p>The report may have been removed or the link may be incorrect.</p><a class=\"button\" href=\"/\">Run a free audit</a>" }));
      }
      const report = sanitizePublicAuditReport(data.report);
      let domain = "your website";
      try { domain = new URL(report.finalUrl || report.url).hostname; } catch { /* generic label */ }
      const title = "Website performance audit for " + domain + " | SiteLift";
      const description = "View real Lighthouse scores and prioritized website performance recommendations for " + domain + ".";
      const canonical = "https://sitelift.vercel.app/report/" + data.id;
      const scores = report.scores.map((score) => {
        const rating = ["good", "needs-work", "poor"].includes(score.rating) ? score.rating : "unknown";
        const value = score.value === null ? "—" : escapeHtml(score.value) + "/100";
        return "<li class=\"score " + rating + "\"><span>" + escapeHtml(score.label) + "</span><strong>" + value + "</strong><small>" + escapeHtml(score.ratingLabel) + "</small></li>";
      }).join("");
      const recommendations = report.opportunities.slice(0, 5).map((item) =>
        "<li><strong>" + escapeHtml(item.title) + "</strong>" +
        (item.displayValue ? "<span>" + escapeHtml(item.displayValue) + "</span>" : "") +
        "<p>" + escapeHtml(item.description) + "</p></li>"
      ).join("");
      const content = "<p class=\"eyebrow\">SHAREABLE LIGHTHOUSE REPORT · " + escapeHtml(report.strategy.toUpperCase()) + "</p>" +
        "<h1>Website performance audit for <span>" + escapeHtml(domain) + "</span></h1>" +
        "<p class=\"intro\">A public summary of real Lighthouse measurements and prioritized recommendations. Share this page with the business owner or your web team.</p>" +
        "<ul class=\"score-grid\">" + (scores || "<li class=\"score\"><span>Scores</span><strong>Unavailable</strong></li>") + "</ul>" +
        "<section><h2>Recommended next steps</h2><ol>" + (recommendations || "<li>Review the full audit with a web professional.</li>") + "</ol></section>" +
        "<div class=\"actions\"><a class=\"button\" href=\"/audit/" + data.id + "\">Open interactive report ↗</a>" +
        "<a class=\"button secondary\" href=\"https://wa.me/?text=" + encodeURIComponent("SiteLift website audit for " + domain + ": " + canonical) + "\">Send to business owner on WhatsApp ↗</a></div>" +
        "<p class=\"muted\">Audited " + escapeHtml(report.fetchedAt || "date not supplied") + ". Results can vary between runs.</p>";
      res.status(200);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
      return res.end(renderPage({ title, description, canonical, content }));
    } catch (error) {
      console.error("Public report render failed", error?.message);
      res.status(503).setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(renderPage({ title: "SiteLift report temporarily unavailable", description: "The report service is temporarily unavailable.", canonical: "https://sitelift.vercel.app/", content: "<h1>Report temporarily unavailable</h1><p>Please try again shortly.</p><a class=\"button\" href=\"/\">Return to SiteLift</a>" }));
    }
  };
}

export default createPublicReportHandler();
