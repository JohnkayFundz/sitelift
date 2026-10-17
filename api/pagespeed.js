const WINDOW_MS = 10 * 60_000;
const MAX_REQUESTS_PER_WINDOW = 5;
const MAX_TRACKED_CLIENTS = 10_000;
const requestCounts = new Map();

function send(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.json(body);
}

export function isPublicWebUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  if (parsed.username || parsed.password) return false;
  if (!host || host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") ||
      host.endsWith(".test") || host.endsWith(".invalid") ||
      host.endsWith(".example")) return false;
  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) return false;
  // Reject IP literals entirely; this endpoint only needs public DNS hostnames.
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return false;
  if (host.split(".").some((label) => !label || label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return false;
  if (parsed.port && !["80", "443"].includes(parsed.port)) return false;
  if (host === "metadata.google.internal" || host === "metadata") return false;

  return true;
}

function allowRequest(req) {
  const forwarded = req.headers?.["x-forwarded-for"];
  const client = (Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded || req.headers?.["x-real-ip"] || req.socket?.remoteAddress || "unknown")
    .split(",")[0].trim();
  const now = Date.now();

  for (const [key, entry] of requestCounts) {
    if (entry.resetAt <= now) requestCounts.delete(key);
  }

  if (!requestCounts.has(client) && requestCounts.size >= MAX_TRACKED_CLIENTS) {
    return false;
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
    res.setHeader("Retry-After", "600");
    return send(res, 429, {
      error: "Too many audits from this connection. Please wait ten minutes and try again."
    });
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};
  const { url, strategy = "mobile" } = body;

  if (typeof url !== "string" || !isPublicWebUrl(url)) {
    return send(res, 400, {
      error: "Enter a valid public website address using http or https."
    });
  }
  if (!["mobile", "desktop"].includes(strategy)) {
    return send(res, 400, { error: "Choose mobile or desktop for the audit." });
  }

  const apiKey = process.env.PAGESPEED_API_KEY;
  if (!apiKey) {
    return send(res, 503, {
      error: "The audit service is temporarily unavailable because its server configuration is incomplete."
    });
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
      if (upstream.status === 429) {
        res.setHeader("Retry-After", "600");
        return send(res, 429, {
          error: "Google's PageSpeed service is temporarily rate-limited. Please wait ten minutes and retry."
        });
      }
      if ([400, 403].includes(upstream.status)) {
        return send(res, 502, {
          error: "Google could not run this audit. Check that the website is public and try again."
        });
      }
      return send(res, 502, {
        error: "Google's audit service is temporarily unavailable. Please try again shortly."
      });
    }

    const lighthouse = payload.lighthouseResult;
    const categories = lighthouse?.categories;
    if (!categories) {
      return send(res, 502, {
        error: "Google returned an incomplete audit report. Please try again."
      });
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
      ["first-contentful-paint", "First Contentful Paint"],
      ["largest-contentful-paint", "Largest Contentful Paint"],
      ["speed-index", "Speed Index"],
      ["total-blocking-time", "Total Blocking Time"],
      ["cumulative-layout-shift", "Cumulative Layout Shift"],
      ["interactive", "Time to Interactive"]
    ];
    const metrics = metricDefinitions.map(([key, label]) => {
      const audit = lighthouse.audits?.[key];
      return {
        key,
        label,
        value: audit?.displayValue ||
          (typeof audit?.numericValue === "number" ? String(audit.numericValue) : "Not available")
      };
    }).filter((item) => item.value !== "Not available");

    const opportunities = Object.values(lighthouse.audits || {})
      .filter((audit) =>
        audit &&
        typeof audit.score === "number" &&
        audit.score < 0.9 &&
        ["opportunity", "table", "metricSavings", "binary"].includes(audit.details?.type) &&
        audit.title &&
        audit.id
      )
      .map((audit) => ({
        id: audit.id,
        title: audit.title,
        displayValue: audit.displayValue || "",
        description: String(audit.description || "")
          .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
          .slice(0, 500),
        score: audit.score,
        savingsMs: Number(audit.details?.overallSavingsMs) || 0,
        savingsBytes: Number(audit.details?.overallSavingsBytes) || 0
      }))
      .sort((a, b) => (b.savingsMs - a.savingsMs) || (b.savingsBytes - a.savingsBytes) || (a.score - b.score))
      .slice(0, 8)
      .map((item) => {
        delete item.score;
        delete item.savingsMs;
        delete item.savingsBytes;
        return item;
      });

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
