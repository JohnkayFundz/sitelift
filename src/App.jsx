import { useMemo, useState } from "react";
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

function App() {
  const [website, setWebsite] = useState("");
  const [auditMessage, setAuditMessage] = useState("");
  const [auditResult, setAuditResult] = useState(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [strategy, setStrategy] = useState("mobile");
  const [checkedItems, setCheckedItems] = useState([]);

  const totalItems = checklist.reduce(
    (total, group) => total + group.items.length,
    0
  );

  const progress = useMemo(
    () => Math.round((checkedItems.length / totalItems) * 100),
    [checkedItems.length, totalItems]
  );

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

  return (
    <div className="site-shell">
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
              Turn your website into a <span>better business tool.</span>
            </h1>

            <p className="hero-description">
              Find opportunities to improve your website experience,
              search visibility, performance, and customer enquiries.
              Start with practical guidance, not confusing technical jargon.
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
                      <div className={`score-ring score-${score.rating}`}><strong>{score.value ?? "—"}</strong></div>
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
                tracked while this page remains open.
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
