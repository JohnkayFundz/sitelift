const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 4;
const requestCounts = new Map();

function send(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.json(body);
}

function isPublicWebUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  if (parsed.username || parsed.password) return false;
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) return false;

  // Reject literal IP addresses entirely; the audit is intended for public domain names.
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return false;
  if (host === "metadata.google.internal" || host === "metadata") return false;
  return true;
}

function allowRequest(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const client = (Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket?.remoteAddress || "unknown")
    .split(",")[0].trim();
  const now = Date.now();
  for (const [key, entry] of requestCounts) {
    if (entry.resetAt <= now) requestCounts.delete(key);
  }
  const entry = requestCounts.get(client);
  if (!entry || entry.resetAt <= now) {
    requestCounts.set(client, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_REQUESTS_PER_WINDOW) return false;
  entry.count += 1;
  return true;
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Use POST to run a website audit." });
  }

  if (!allowRequest(req)) {
    return send(res, 429, { error: "Too many audits from this connection. Please wait one minute and try again." });
  }

  const apiKey = process.env.PAGESPEED_API_KEY;
  if (!apiKey) {
    return send(res, 503, {
      error: "The audit engine needs a Google PageSpeed Insights API key. Add PAGESPEED_API_KEY in Vercel Project Settings → Environment Variables, then redeploy."
    });
  }

  const { url, strategy = "mobile" } = req.body || {};
  if (typeof url !== "string" || url.length > 2048 || !isPublicWebUrl(url)) {
    return send(res, 400, { error: "Enter a valid public website address using http or https." });
  }
  if (!["mobile", "desktop"].includes(strategy)) {
    return send(res, 400, { error: "Choose mobile or desktop for the audit." });
  }

  const endpoint = new URL("https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed");
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("strategy", strategy);
  endpoint.searchParams.set("key", apiKey);
  for (const category of ["PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES", "SEO"]) {
    endpoint.searchParams.append("category", category);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 52_000);
  try {
    const upstream = await fetch(endpoint, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
    const payload = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      const upstreamMessage = payload?.error?.message;
      if (upstream.status === 429) {
        return send(res, 429, { error: "Google's PageSpeed service is temporarily rate-limited. Please wait a little and retry." });
      }
      if (upstream.status === 400 || upstream.status === 403) {
        return send(res, 502, { error: upstreamMessage || "Google could not run this audit. Check the URL and PageSpeed API configuration." });
      }
      return send(res, 502, { error: "Google's audit service is temporarily unavailable. Please try again shortly." });
    }

    const lighthouse = payload.lighthouseResult;
    const categories = lighthouse?.categories;
    if (!categories) {
      return send(res, 502, { error: "Google returned an incomplete audit report. Please try again." });
    }

    const categoryDefinitions = [
      ["performance", "Performance"],
      ["accessibility", "Accessibility"],
      ["best-practices", "Best practices"],
      ["seo", "SEO"]
    ];
    const scores = categoryDefinitions.map(([key, label]) => {
      const raw = categories[key]?.score;
      const value = typeof raw === "number" ? Math.round(raw * 100) : null;
      const rating = value === null ? "unknown" : value >= 90 ? "good" : value >= 50 ? "needs-work" : "poor";
      return {
        key,
        label,
        value,
        rating,
        ratingLabel: value === null ? "Not available" : value >= 90 ? "Good" : value >= 50 ? "Needs improvement" : "Poor"
      };
    });

    const metricDefinitions = [
      ["first-contentful-paint", "First Contentful Paint", (v) => v],
      ["largest-contentful-paint", "Largest Contentful Paint", (v) => v],
      ["speed-index", "Speed Index", (v) => v],
      ["total-blocking-time", "Total Blocking Time", (v) => v],
      ["cumulative-layout-shift", "Cumulative Layout Shift", (v) => v],
      ["interactive", "Time to Interactive", (v) => v]
    ];
    const metrics = metricDefinitions.map(([key, label, format]) => {
      const audit = lighthouse.audits?.[key];
      return {
        key,
        label,
        value: audit?.displayValue || (typeof audit?.numericValue === "number" ? format(audit.numericValue) : "Not available")
      };
    }).filter((item) => item.value !== "Not available");

    const opportunities = Object.values(lighthouse.audits || {})
      .filter((audit) =>
        audit &&
        audit.score !== null &&
        typeof audit.score === "number" &&
        audit.score < 0.9 &&
        ["opportunity", "table", "metricSavings", "binary"].includes(audit.details?.type) &&
        audit.title &&
        audit.id
      )
      .slice(0, 8)
      .map((audit) => ({
        id: audit.id,
        title: audit.title,
        displayValue: audit.displayValue || "",
        description: String(audit.description || "").replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1").slice(0, 500)
      }));

    return send(res, 200, {
      url,
      finalUrl: lighthouse.finalDisplayedUrl || lighthouse.finalUrl || url,
      strategy,
      fetchedAt: new Date().toISOString(),
      scores,
      metrics,
      opportunities
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return send(res, 504, { error: "Google's audit took too long to respond. Please try again." });
    }
    return send(res, 502, { error: "Unable to reach Google's audit service. Check your connection and retry." });
  } finally {
    clearTimeout(timeout);
  }
}
