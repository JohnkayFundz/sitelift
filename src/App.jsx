import { useEffect, useMemo, useState } from "react";
import "./App.css";

const checklist = [
  {
    category: "First Impressions & Trust",
    items: [
      "The homepage clearly explains what the business does.",
      "The business name and logo are easy to recognize.",
      "Product and service descriptions use plain language.",
      "Pricing or a clear request-a-quote option is available.",
      "Phone, email, or another contact option is visible.",
      "Customer reviews or testimonials build trust.",
      "The business location or service area is stated.",
      "The website uses HTTPS with a valid certificate.",
      "Images and graphics look professional and consistent.",
      "The main call-to-action is easy to find."
    ]
  },
  {
    category: "Mobile Experience",
    items: [
      "The layout adapts to phones, tablets, and desktops.",
      "Buttons and links are easy to tap.",
      "Text is comfortably readable on mobile.",
      "Pages do not require awkward horizontal scrolling.",
      "Important contact options remain easy to access.",
      "The mobile navigation menu works correctly.",
      "Links and menu items have adequate spacing.",
      "Essential content loads promptly on mobile networks.",
      "Forms use appropriate input types for mobile.",
      "Pop-ups do not obstruct the main content."
    ]
  },
  {
    category: "Speed & Performance",
    items: [
      "Images are compressed and appropriately sized.",
      "Below-the-fold images use lazy loading where appropriate.",
      "Server response time is measured and optimized.",
      "Static assets use suitable browser caching.",
      "CSS and JavaScript assets are optimized for production.",
      "Unnecessary third-party scripts are removed or deferred.",
      "Large pages use efficient loading and code splitting.",
      "Internal links and images do not return broken responses.",
      "Embedded videos avoid unnecessary initial loading.",
      "Content does not unexpectedly shift while loading."
    ]
  },
  {
    category: "Search Engine Basics",
    items: [
      "Every important page has a descriptive title.",
      "Important pages have useful meta descriptions.",
      "Headings follow a logical hierarchy.",
      "Meaningful images have appropriate alternative text.",
      "URLs are readable and describe their content.",
      "An up-to-date XML sitemap is available where appropriate.",
      "Robots.txt does not accidentally block important pages.",
      "Relevant structured business data is accurate.",
      "The website has a recognizable favicon.",
      "Social sharing metadata is configured appropriately."
    ]
  },
  {
    category: "Contact, Conversion & Security",
    items: [
      "A working WhatsApp contact link is easy to find if applicable.",
      "Phone and email links work on supported devices.",
      "Contact forms request only necessary information.",
      "Forms confirm successful submission and report errors.",
      "Returns, guarantees, or service policies are easy to find.",
      "Business opening hours or response times are stated.",
      "Forms use suitable anti-spam protections.",
      "Privacy information is available where appropriate.",
      "Enquiries reach the right person or notification system.",
      "Analytics are configured appropriately, respecting privacy."
    ]
  }
];

function getWebsiteValidation(value) {
  if (!value.trim()) return { valid: false, message: "" };
  try {
    const normalized = /^https?:\/\//i.test(value.trim()) ? value.trim() : "https://" + value.trim();
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();
    const valid = ["http:", "https:"].includes(url.protocol) && host.includes(".") && !host.startsWith(".") && !host.endsWith(".") && !url.username && !url.password && host !== "localhost" && !host.endsWith(".local") && !host.endsWith(".internal") && (!url.port || ["80", "443"].includes(url.port));
    return valid ? { valid: true, message: "Website address looks valid. We will run a real Lighthouse test." } : { valid: false, message: "Enter a public website address, such as example.com." };
  } catch { return { valid: false, message: "Enter a public website address, such as example.com." }; }
}

function App() {
  const [website, setWebsite] = useState(() => new URLSearchParams(window.location.search).get("url") || "");
  const [auditMessage, setAuditMessage] = useState("");
  const [auditResult, setAuditResult] = useState(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [paymentEmail, setPaymentEmail] = useState("");
  const [paymentWhatsapp, setPaymentWhatsapp] = useState("");
  const [leadEmail, setLeadEmail] = useState("");
  const [leadWhatsapp, setLeadWhatsapp] = useState("");
  const [leadMessage, setLeadMessage] = useState("");
  const [leadSubmitting, setLeadSubmitting] = useState(false);
  const [leadWhatsappUrl, setLeadWhatsappUrl] = useState("");
  const [paymentMessage, setPaymentMessage] = useState("");
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [recoveryVisible, setRecoveryVisible] = useState(false);
  const [recoveryReference, setRecoveryReference] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("reference") || params.get("trxref") || "";
  });
  const [recoverySending, setRecoverySending] = useState(false);
  const [strategy, setStrategy] = useState(() => new URLSearchParams(window.location.search).get("strategy") === "desktop" ? "desktop" : "mobile");
  const [checkedItems, setCheckedItems] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem("sitelift-checklist-v1") || "[]");
      return Array.isArray(value) ? value.filter((id) => typeof id === "string" && /^\d+-\d+$/.test(id)) : [];
    } catch { return []; }
  });
  const [darkMode, setDarkMode] = useState(() => {
    try { return localStorage.getItem("sitelift-theme") !== "light"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("sitelift-checklist-v1", JSON.stringify(checkedItems)); } catch { /* storage may be unavailable */ }
  }, [checkedItems]);
  useEffect(() => {
    const id = window.location.pathname.startsWith("/audit/") ? window.location.pathname.slice(7) : "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) return;
    let cancelled = false;
    fetch("/api/audit/" + id).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to load this report.");
      if (!cancelled) { setWebsite(payload.finalUrl || payload.url || ""); setStrategy(payload.strategy || "mobile"); setAuditResult(payload); }
    }).catch((error) => { if (!cancelled) setAuditMessage(error.message || "Unable to load this report."); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reference = params.get("reference") || params.get("trxref");
    const token = params.get("token");
    if (params.get("payment") !== "return" || !reference || !token) return;
    let cancelled = false, attempts = 0;

    const showExpiredToken = () => {
      if (cancelled) return;
      setRecoveryVisible(true);
      setRecoveryReference(reference);
      setPaymentMessage("Your 24-hour download link has expired. Enter the email address used at checkout and your payment reference to receive a fresh secure link.");
    };

    const verifyForDownload = async () => {
      const response = await fetch("/api/paystack/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference, token })
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 403 && result.reason === "expired_token") {
        showExpiredToken();
        return true;
      }
      if (result.status === "paid" && result.downloadUrl) {
        if (!cancelled) {
          setDownloadUrl(result.downloadUrl);
          setPaymentMessage("Payment confirmed. Your secure download link expires in one hour.");
        }
        return true;
      }
      return false;
    };

    const checkReadOnlyStatus = async () => {
      attempts += 1;
      try {
        const response = await fetch("/api/paystack/status?reference=" + encodeURIComponent(reference) + "&token=" + encodeURIComponent(token));
        const result = await response.json().catch(() => ({}));
        if (response.status === 403 && result.reason === "expired_token") {
          showExpiredToken();
          return;
        }
        if (result.status === "paid" && result.downloadReady) {
          const complete = await verifyForDownload();
          if (complete || cancelled) return;
        }
        if (!cancelled && attempts < 12) window.setTimeout(checkReadOnlyStatus, 2500);
        else if (!cancelled) setPaymentMessage("Payment is still processing. Refresh this page in a moment to check again.");
      } catch {
        if (!cancelled && attempts < 12) window.setTimeout(checkReadOnlyStatus, 2500);
        else if (!cancelled) setPaymentMessage("Unable to check payment status right now. Please refresh in a moment.");
      }
    };

    (async () => {
      try {
        const complete = await verifyForDownload();
        if (!complete && !cancelled) checkReadOnlyStatus();
      } catch {
        if (!cancelled) checkReadOnlyStatus();
      }
    })();

    return () => { cancelled = true; };
  }, []);
  const requestFreshDownloadLink = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(paymentEmail.trim())) {
      setPaymentMessage("Enter the email address used at checkout.");
      return;
    }
    if (!/^sitelift_[0-9a-f-]{36}_[a-f0-9]{32}$/i.test(recoveryReference.trim())) {
      setPaymentMessage("Enter the payment reference from your Paystack receipt.");
      return;
    }
    setRecoverySending(true);
    setPaymentMessage("");
    try {
      const response = await fetch("/api/paystack/resend-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: recoveryReference.trim(), email: paymentEmail.trim() })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Secure link recovery is temporarily unavailable.");
      setPaymentMessage(result.message || "If the reference and email match a paid record, a fresh download link has been sent to your email.");
    } catch (error) {
      setPaymentMessage(error.message || "Secure link recovery is temporarily unavailable. Please try again later.");
    } finally {
      setRecoverySending(false);
    }
  };

  const buyPdfReport = async () => {
    if (!auditResult?.auditId) { setPaymentMessage("Run an audit first to create a report."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(paymentEmail.trim())) { setPaymentMessage("Enter a valid email address for your receipt."); return; }
    const normalizedWhatsapp = paymentWhatsapp.replace(/[\s().-]/g, "");
    if (!/^\+?[1-9]\d{7,14}$/.test(normalizedWhatsapp)) { setPaymentMessage("Enter a WhatsApp number with country code, for example +2348012345678."); return; }
    setPaymentLoading(true); setPaymentMessage("");
    try {
      const response = await fetch("/api/paystack/initialize", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auditId: auditResult.auditId, email: paymentEmail.trim(), whatsapp: normalizedWhatsapp })
      });
      const result = await response.json();
      if (!response.ok || !result.authorizationUrl) throw new Error(result.error || "Unable to start checkout.");
      window.location.assign(result.authorizationUrl);
    } catch (error) { setPaymentMessage(error.message || "Unable to start checkout."); }
    finally { setPaymentLoading(false); }
  };
  useEffect(() => {
    try { localStorage.setItem("sitelift-theme", darkMode ? "dark" : "light"); } catch { /* storage may be unavailable */ }
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
    const meta = document.querySelector('meta[name="description"]');
    document.title = auditResult ? "SiteLift audit — " + new URL(auditResult.finalUrl || auditResult.url).hostname : "SiteLift — Free Mobile Speed Checker Nigeria";
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) canonical.href = auditResult?.auditId ? window.location.origin + "/report/" + auditResult.auditId : "https://sitelift.vercel.app/";
    const ogTitle = document.querySelector('meta[property="og:title"]');
    const ogDescription = document.querySelector('meta[property="og:description"]');
    const ogUrl = document.querySelector('meta[property="og:url"]');
    if (ogTitle) ogTitle.content = document.title;
    if (ogDescription && auditResult) ogDescription.content = "Real Lighthouse website audit for " + (auditResult.finalUrl || auditResult.url) + ". Open the shareable SiteLift report for scores and recommended improvements.";
    if (ogUrl) ogUrl.content = auditResult?.auditId ? window.location.origin + "/report/" + auditResult.auditId : "https://sitelift.vercel.app/";
    if (meta && auditResult) meta.content = "Lighthouse report for " + (auditResult.finalUrl || auditResult.url) + ". Review performance, accessibility, best practices, SEO, and prioritized improvements.";
    document.getElementById("sitelift-jsonld")?.remove();
    const schema = document.createElement("script");
    schema.id = "sitelift-jsonld";
    schema.type = "application/ld+json";
    schema.textContent = JSON.stringify([
      { "@context": "https://schema.org", "@type": "WebSite", name: "SiteLift", url: "https://sitelift.vercel.app/" },
      { "@context": "https://schema.org", "@type": "SoftwareApplication", name: "SiteLift Website Audit", applicationCategory: "WebApplication", operatingSystem: "Any", offers: { "@type": "Offer", price: "0", priceCurrency: "NGN" }, url: "https://sitelift.vercel.app/" }
    ]);
    document.head.appendChild(schema);
  }, [checkedItems, darkMode, auditResult]);

  const totalItems = checklist.reduce(
    (total, group) => total + group.items.length,
    0
  );

  const progress = useMemo(
    () => Math.round((checkedItems.length / totalItems) * 100),
    [checkedItems.length, totalItems]
  );
  const websiteValidation = getWebsiteValidation(website);
  const publicReportUrl = auditResult?.auditId ? window.location.origin + "/report/" + auditResult.auditId : "";

  async function handleAuditSubmit(event) {
    event.preventDefault();
    setAuditMessage("");
    setAuditResult(null);

    let parsedUrl;
    try {
      const trimmed = website.trim();
      const normalizedUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      parsedUrl = new URL(normalizedUrl);
      if (
        !["http:", "https:"].includes(parsedUrl.protocol) ||
        !parsedUrl.hostname.includes(".") ||
        parsedUrl.hostname.startsWith(".") ||
        parsedUrl.hostname.endsWith(".") ||
        parsedUrl.username ||
        parsedUrl.password
      ) {
        throw new Error("Invalid website address");
      }
    } catch {
      setAuditMessage("Enter a valid public website address, such as example.com.");
      return;
    }

    setWebsite(parsedUrl.href);
    setAuditLoading(true);
    try {
      const response = await fetch("/api/pagespeed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: parsedUrl.href, strategy })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "The audit could not be completed. Please try again shortly.");
      }
      setAuditResult(payload);
      if (payload.auditId) window.history.replaceState({}, "", "/audit/" + payload.auditId);
      setAuditMessage("Audit complete. These scores come from Google's Lighthouse test for the selected device.");
    } catch (error) {
      setAuditMessage(error.message || "The audit could not be completed. Please try again.");
    } finally {
      setAuditLoading(false);
    }
  }

  function toggleItem(itemId) {
    setCheckedItems((current) =>
      current.includes(itemId)
        ? current.filter((id) => id !== itemId)
        : [...current, itemId]
    );
  }

  async function submitOptimizationLead(event) {
    event.preventDefault();
    setLeadMessage("");
    setLeadWhatsappUrl("");
    if (!auditResult?.auditId) {
      setLeadMessage("Run a free audit first so we can attach your request to the correct report.");
      return;
    }
    const normalizedWhatsapp = leadWhatsapp.replace(/[\\s().-]/g, "");
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(leadEmail.trim()) || !/^\\+?[1-9]\\d{7,14}$/.test(normalizedWhatsapp)) {
      setLeadMessage("Enter a valid email and WhatsApp number with country code.");
      return;
    }
    let websiteUrl;
    try {
      const rawWebsite = auditResult.finalUrl || auditResult.url || website;
      websiteUrl = new URL(/^https?:\\/\\//i.test(rawWebsite) ? rawWebsite : "https://" + rawWebsite).href;
    } catch {
      setLeadMessage("We could not validate the audited website. Run the audit again and retry.");
      return;
    }
    setLeadSubmitting(true);
    try {
      const response = await fetch("/api/leads/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: leadEmail.trim(), websiteUrl, phone: normalizedWhatsapp, businessType: "website_optimization", auditId: auditResult.auditId, source: "site_lift_optimization_plan", landingPage: window.location.pathname, marketingConsent: false })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || "Your request could not be saved. Please try again shortly.");
      setLeadMessage("Request received. Your checklist email is queued; continue on WhatsApp to discuss the paid plan.");
      const message = "Hi JohnKay, please prepare a custom SiteLift optimization plan. Website: " + websiteUrl + ". Email: " + leadEmail.trim() + ". WhatsApp: " + normalizedWhatsapp + ". Report: " + publicReportUrl + ". Please confirm scope and price before work.";
      setLeadWhatsappUrl("https://wa.me/2348188840165?text=" + encodeURIComponent(message));
    } catch (error) {
      setLeadMessage(error.message || "Your request could not be saved. Please try again shortly.");
    } finally {
      setLeadSubmitting(false);
    }
  }

  return (
    <div className={darkMode ? "site-shell theme-dark" : "site-shell"}>
      <header className="topbar">
        <a className="brand" href="#home" aria-label="SiteLift home">
          <span className="brand-mark">S</span>
          <span>
            <strong>SiteLift</strong>
            <small>by JohnKay Fundz</small>
          </span>
        </a>

        <nav className="navigation" aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#checklist">Free checklist</a>
          <button className="theme-toggle" type="button" onClick={() => setDarkMode((value) => !value)}>{darkMode ? "☀ Light" : "☾ Dark"}</button>
          <a className="nav-cta" href="#checker">Check my website ↗</a>
        </nav>
      </header>

      <main id="home">
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow">
              <span className="status-dot" />
              A practical toolkit for small businesses
            </div>

            <h1>
              Turn Slow Mobile Websites into <span>Paying Clients.</span>
            </h1>

            <p className="hero-description">
              Find the mobile speed, usability and conversion issues that can cost your business enquiries. Get a real Lighthouse report, clear next steps, and a practical route to a better-performing website.
            </p>

            <div className="hero-actions">
              <a className="button button-primary" href="#checker">
                Check a website <span aria-hidden="true">→</span>
              </a>
              <a className="button button-secondary" href="#checklist">
                Explore the free checklist
              </a>
            </div>

            <div className="hero-note">
              <span aria-hidden="true">✓</span>
              Practical guidance for shops, service providers, and growing businesses.
            </div>
          </div>

          <div className="preview-card" aria-label="SiteLift audit categories">
            <div className="preview-top">
              <div>
                <span className="preview-label">YOUR WEBSITE TOOLKIT</span>
                <h2>Room to improve?</h2>
              </div>
              <span className="preview-icon">↗</span>
            </div>

            <p className="preview-description">
              Start with the areas that matter most to your visitors.
            </p>

            <div className="preview-list">
              <div className="preview-row">
                <span className="category-icon icon-blue">◷</span>
                <span><strong>Performance</strong><small>Loading and responsiveness</small></span>
                <span className="row-arrow">→</span>
              </div>
              <div className="preview-row">
                <span className="category-icon icon-green">⌕</span>
                <span><strong>SEO basics</strong><small>Help search engines understand your pages</small></span>
                <span className="row-arrow">→</span>
              </div>
              <div className="preview-row">
                <span className="category-icon icon-purple">▣</span>
                <span><strong>Mobile experience</strong><small>Make browsing easier on phones</small></span>
                <span className="row-arrow">→</span>
              </div>
              <div className="preview-row">
                <span className="category-icon icon-orange">↗</span>
                <span><strong>Contact & conversion</strong><small>Make the next step obvious</small></span>
                <span className="row-arrow">→</span>
              </div>
            </div>

            <div className="preview-footer">
              <span className="footer-check">✓</span>
              <span>Understand what to improve and why.</span>
            </div>
            <div className="micro-metrics" aria-label="What the audit measures">
              <div><span>⚡</span><strong>PageSpeed score</strong><small>Real Lighthouse data</small></div>
              <div><span>▣</span><strong>Mobile viewport</strong><small>Mobile-first checks</small></div>
              <div><span>↗</span><strong>CTA visibility</strong><small>Conversion checklist</small></div>
            </div>
            <div className="comparison-preview" aria-label="Illustrative before and improvement direction">
              <div className="comparison-panel comparison-before"><span>BEFORE</span><strong>Friction for mobile visitors</strong><small>Slow-loading pages · unclear next step</small></div>
              <div className="comparison-arrow" aria-hidden="true">→</div>
              <div className="comparison-panel comparison-after"><span>SITELIFT DIRECTION</span><strong>Prioritized improvements</strong><small>Speed fixes · clearer contact CTA</small></div>
              <p>Illustrative guidance, not a claim that SiteLift has changed the website.</p>
            </div>
          </div>
        </section>

        <section className="checker-section" id="checker">
          <div className="section-heading">
            <span className="section-kicker">START HERE</span>
            <h2>What can we improve on your website?</h2>
            <p>
              Enter a public website address to run a real Google Lighthouse audit.
            </p>
          </div>

          <form className="url-form" onSubmit={handleAuditSubmit}>
            <label htmlFor="website-url">Your website address</label>
            <div className="input-row">
              <span className="input-prefix" aria-hidden="true">↗</span>
              <input
                id="website-url"
                type="text"
                inputMode="url"
                autoComplete="url"
                placeholder="https://yourbusiness.com"
                value={website}
                aria-invalid={Boolean(website.trim()) && !websiteValidation.valid}
                onChange={(event) => {
                  setWebsite(event.target.value);
                  setAuditMessage("");
                  setAuditResult(null);
                }}
                required
              />
              <select className="strategy-select" aria-label="Audit device" value={strategy} disabled={auditLoading} onChange={(event) => { setStrategy(event.target.value); setAuditMessage(""); setAuditResult(null); }}>
                <option value="mobile">Mobile</option>
                <option value="desktop">Desktop</option>
              </select>
              <button className="button button-primary" type="submit" disabled={auditLoading}>
                {auditLoading ? "Auditing…" : "Run free audit →"}
              </button>
            </div>
            <div className="sample-site-row"><span>Try a sample:</span><button type="button" className="sample-site-button" onClick={() => { setWebsite("https://example.com"); setAuditMessage(""); setAuditResult(null); }}>example.com ↗</button></div>
            {websiteValidation.message && <p className={"url-validation " + (websiteValidation.valid ? "is-valid" : "is-invalid")} aria-live="polite">{websiteValidation.message}</p>}
            {auditMessage && (
              <p className="form-message" role="status">{auditMessage}</p>
            )}
            <p className="form-help">
              Uses Google PageSpeed Insights and Lighthouse. Results may take up to a minute; no fabricated scores.
            </p>
            {auditLoading && (
              <div className="audit-loading" role="status">
                <span className="loading-spinner" /> Running a real {strategy} audit. This can take up to a minute.
              </div>
            )}
            {auditResult && (
              <section className="audit-results" aria-live="polite">
                <div className="audit-results-heading">
                  <div>
                    <span className="section-kicker">LIGHTHOUSE REPORT</span>
                    <h3>Results for {auditResult.finalUrl || auditResult.url}</h3>
                    <p>Tested on {auditResult.strategy}. Scores are lab measurements and can vary between runs.</p>
                  </div>
                  <span className="audit-timestamp">{new Date(auditResult.fetchedAt).toLocaleString()}</span>
                </div>
                <div className="score-grid">
                  {auditResult.scores.map((score) => (
                    <article className="score-card" key={score.key}>
                      <svg className={`score-ring score-${score.rating}`} viewBox="0 0 72 72" role="img" aria-label={`${score.label}: ${score.value ?? "not available"} out of 100`}><circle className="score-ring-track" cx="36" cy="36" r="29" /><circle className="score-ring-value" cx="36" cy="36" r="29" transform="rotate(-90 36 36)" strokeDasharray="182.2" strokeDashoffset={182.2 - (Math.max(0, Math.min(100, Number(score.value) || 0)) / 100) * 182.2} /></svg><strong className="score-number">{score.value ?? "—"}</strong>
                      <h4>{score.label}</h4>
                      <span className={`score-rating rating-${score.rating}`}>{score.ratingLabel}</span>
                    </article>
                  ))}
                </div>
                <div className="audit-details-grid">
                  <article className="audit-detail-card">
                    <h4>Core Web Vitals & loading metrics</h4>
                    <dl className="metrics-list">
                      {auditResult.metrics.map((metric) => (
                        <div key={metric.key}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>
                      ))}
                    </dl>
                  </article>
                  <article className="audit-detail-card">
                    <h4>Recommended improvements</h4>
                    {auditResult.opportunities.length ? (
                      <ul className="opportunity-list">
                        {auditResult.opportunities.map((item) => (
                          <li key={item.id}>
                            <strong>{item.title}</strong>
                            {item.displayValue && <span>{item.displayValue}</span>}
                            <p>{item.description}</p>
                          </li>
                        ))}
                      </ul>
                    ) : <p>No Lighthouse opportunities were returned for this run. Review the category scores and rerun if needed.</p>}
                  </article>
                </div>
                <div className="result-cta">
                  <div>
                    <strong>Want help fixing these findings?</strong>
                    <p>Send this website address to JohnKay Fundz to discuss practical next steps.</p>
                  </div>
                  <a className="button button-primary" href={`https://wa.me/2348188840165?text=${encodeURIComponent(`Hi JohnKay, I ran a SiteLift audit for ${auditResult.finalUrl || auditResult.url} and would like help improving it.`)}`} target="_blank" rel="noreferrer">Discuss improvements ↗</a>
                  <a className="button button-secondary" href={"https://wa.me/?text=" + encodeURIComponent("SiteLift website audit for " + (auditResult.finalUrl || auditResult.url) + ": " + publicReportUrl)} target="_blank" rel="noreferrer">Send report to owner ↗</a>
                  <div className="paid-report-box">
                    <h4>Download the full unbranded PDF report</h4>
                    <p>One-time payment: ₦2,500. Includes your scores, metrics and prioritized recommendations.</p>
                    {!downloadUrl && <label className="report-email-label">Email for payment receipt
                      <input type="email" autoComplete="email" value={paymentEmail} onChange={(event) => setPaymentEmail(event.target.value)} placeholder="you@example.com" />
                    </label>}
                    {!downloadUrl && <label className="report-email-label">WhatsApp number with country code
                      <input type="tel" autoComplete="tel" inputMode="tel" value={paymentWhatsapp} onChange={(event) => setPaymentWhatsapp(event.target.value)} placeholder="+2348012345678" required />
                    </label>}
                    {!downloadUrl && !recoveryVisible && <button className="button button-secondary" type="button" disabled={paymentLoading || !auditResult.auditId} onClick={buyPdfReport}>{paymentLoading ? "Connecting to Paystack…" : "Pay ₦2,500 and get PDF"}</button>}
                    {recoveryVisible && !downloadUrl && (
                      <div className="download-recovery-form">
                        <label className="report-email-label">Payment reference
                          <input type="text" autoComplete="off" value={recoveryReference} onChange={(event) => setRecoveryReference(event.target.value)} placeholder="sitelift_…" />
                        </label>
                        <button className="button button-secondary" type="button" disabled={recoverySending} onClick={requestFreshDownloadLink}>
                          {recoverySending ? "Requesting secure link…" : "Email me a fresh secure link"}
                        </button>
                        <small>The link is sent only to the email address recorded at checkout. It is never displayed on this page.</small>
                      </div>
                    )}
                    {downloadUrl && <a className="button button-primary" href={downloadUrl} rel="noreferrer">Download secure PDF ↗</a>}
                    {paymentMessage && <p role="status">{paymentMessage}</p>}
                  </div>
                </div>
                <p className="checklist-disclaimer">These results reflect an automated Lighthouse lab test, not a guarantee of search ranking or real-world user experience. Google may return no field data for low-traffic websites.</p>
              </section>
            )}
          </form>
        </section>

        <section className="conversion-section" id="get-help">
          <div className="conversion-copy">
            <span className="section-kicker">WANT A HAND?</span>
            <h2>Turn your website findings into real improvements.</h2>
            <p>
              Not sure what to fix first? Send me your website and business type.
              I’ll help you identify three practical improvements. If you want me
              to implement them, I’ll explain the scope and price before any work begins.
            </p>
            <div className="conversion-actions">
              <a
                className="button button-primary"
                href="https://wa.me/2348188840165?text=Hi%20JohnKay%2C%20I%20used%20SiteLift%20and%20would%20like%20help%20improving%20my%20website.%20My%20website%20is%3A%20"
                target="_blank"
                rel="noreferrer"
              >
                Get help on WhatsApp <span aria-hidden="true">↗</span>
              </a>
              <a className="button button-secondary" href="https://johnkayfundz.github.io/portfolio-website/" target="_blank" rel="noreferrer">
                View my work
              </a>
            </div>
            <p className="conversion-note">No payment required to start a conversation. Any paid work is agreed with you first.</p>
          </div>
          <div className="conversion-points">
            <div><span>01</span><p><strong>Website improvements</strong><small>Mobile layout, speed, and usability</small></p></div>
            <div><span>02</span><p><strong>Business websites</strong><small>Clear services, trust, and contact options</small></p></div>
            <div><span>03</span><p><strong>Online stores & React apps</strong><small>Practical features built around your goals</small></p></div>
          </div>
        </section>

        <section className="pricing-section" id="pricing">
          <div className="section-heading"><span className="section-kicker">FROM INSIGHT TO IMPACT</span><h2>Get the fixes, not just the score.</h2><p>Transparent starting price. Scope and delivery timing are confirmed before paid work begins.</p></div>
          <div className="pricing-card">
            <div><span className="pricing-label">CUSTOM WEBSITE LIFT PACKAGE</span><h3>Professional Speed &amp; Conversion Overhaul</h3><p>Prioritized performance fixes, mobile UX improvements, clearer calls to action, and practical implementation notes tailored to your website.</p></div>
            <div className="pricing-price"><strong>₦50,000</strong><small>starting price · per website</small><a className="button button-primary" href={"https://wa.me/2348188840165?text=" + encodeURIComponent("Hi JohnKay, I would like to discuss the SiteLift Website Lift Package for " + (auditResult?.finalUrl || auditResult?.url || website || "my website") + ".")} target="_blank" rel="noreferrer">Discuss my plan ↗</a></div>
            <form className="plan-lead-form" onSubmit={submitOptimizationLead}
              <label>Email<input type="email" autoComplete="email" value={leadEmail} onChange={(event) => setLeadEmail(event.target.value)} placeholder="you@business.com" required /></label>
              <label>WhatsApp number<input type="tel" inputMode="tel" autoComplete="tel" value={leadWhatsapp} onChange={(event) => setLeadWhatsapp(event.target.value)} placeholder="+2348012345678" required /></label>
              <button className="button button-secondary" type="submit" disabled={leadSubmitting || !auditResult?.auditId}>{leadSubmitting ? "Saving your request…" : "Request my custom plan ↗"}</button>
              {leadMessage && <small role="status">{leadMessage}</small>}
              {leadWhatsappUrl && <a className="button button-primary" href={leadWhatsappUrl} target="_blank" rel="noreferrer">Continue on WhatsApp ↗</a>}
              <small>Your request is saved securely through SiteLift lead capture. Marketing consent is not required and remains off by default.</small>
            </form>
          </div>
        </section>

        <section className="how-section" id="how-it-works">
          <div className="section-heading">
            <span className="section-kicker">A CLEARER WAY FORWARD</span>
            <h2>Better websites start with better decisions.</h2>
            <p>Focus on the improvements that help customers and your business.</p>
          </div>

          <div className="benefit-grid">
            <article className="benefit-card">
              <span className="benefit-number">01</span>
              <h3>Understand</h3>
              <p>Identify the website areas worth reviewing, from page content to customer contact options.</p>
            </article>
            <article className="benefit-card">
              <span className="benefit-number">02</span>
              <h3>Prioritize</h3>
              <p>Separate essential fixes from optional improvements so you know where to begin.</p>
            </article>
            <article className="benefit-card">
              <span className="benefit-number">03</span>
              <h3>Improve</h3>
              <p>Use a practical checklist to work through changes and track your progress.</p>
            </article>
          </div>
        </section>

        <section className="checklist-section" id="checklist">
          <div className="checklist-header">
            <div>
              <span className="section-kicker">FREE WEBSITE RESOURCE</span>
              <h2>The 50-point website checklist</h2>
              <p>
                Review your website one item at a time. Your progress is
                saved locally on this device and remains available after refresh.
              </p>
            </div>
            <div className="progress-card">
              <strong>{checkedItems.length}<span> / {totalItems}</span></strong>
              <small>Items reviewed</small>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="Checklist progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
              >
                <span style={{ width: `${progress}%` }} />
              </div>
              <small>{progress}% complete</small>
            </div>
          </div>

          <div className="checklist-groups">
            {checklist.map((group, groupIndex) => {
              const groupChecked = group.items.filter((_, itemIndex) =>
                checkedItems.includes(`${groupIndex}-${itemIndex}`)
              ).length;

              return (
                <article className="checklist-group" key={group.category}>
                  <div className="group-heading">
                    <div>
                      <span className="group-number">
                        {String(groupIndex + 1).padStart(2, "0")}
                      </span>
                      <h3>{group.category}</h3>
                    </div>
                    <span className="group-count">
                      {groupChecked}/10 checked
                    </span>
                  </div>

                  <div className="checklist-items">
                    {group.items.map((item, itemIndex) => {
                      const itemId = `${groupIndex}-${itemIndex}`;
                      return (
                        <label className="checklist-item" key={itemId}>
                          <input
                            type="checkbox"
                            checked={checkedItems.includes(itemId)}
                            onChange={() => toggleItem(itemId)}
                          />
                          <span className="custom-checkbox" aria-hidden="true">✓</span>
                          <span className="checklist-text">
                            <span className="item-number">
                              {groupIndex * 10 + itemIndex + 1}.
                            </span>
                            {item}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>

          <div className="checklist-bottom">
            <div>
              <strong>Small steps add up.</strong>
              <p>Check off each item as you review your website.</p>
            </div>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => window.print()}
            >
              Print or save as PDF ↗
            </button>
          </div>
          <p className="checklist-disclaimer">
            This checklist is a self-review guide, not a technical certification.
            Some items require additional testing to verify.
          </p>
        </section>
      </main>

      <footer className="footer">
        <a className="brand footer-brand" href="#home">
          <span className="brand-mark">S</span>
          <span><strong>SiteLift</strong><small>by JohnKay Fundz</small></span>
        </a>
        <p>Practical website improvement for growing businesses.</p>
        <a href="#home">Back to top ↑</a>
      </footer>
    </div>
  );
}

export default App;
