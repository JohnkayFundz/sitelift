# SiteLift

SiteLift is a lightweight React + Vite website-audit toolkit by JohnKay Fundz. It runs real Google PageSpeed Insights/Lighthouse audits and provides a 50-point manual review checklist.

## Features

- Mobile and desktop Lighthouse audits for performance, accessibility, best practices, and SEO.
- Key loading metrics and ranked Lighthouse opportunities.
- WhatsApp enquiry links for discussing improvements.
- A self-review checklist for business websites.

## Local development

Requirements: Node.js 20.19+ or 22.12+ (Vite 8 requirement).

```bash
npm install
npm run dev
npm test
npm run lint
npm run build
```

## Environment

Set `PAGESPEED_API_KEY` in the Vercel project environment. Create a dedicated Google Cloud API key restricted to the PageSpeed Insights API. Never place the key in frontend code, commit it, or paste it into issues or chat.

The production API route is `POST /api/pagespeed` with JSON `{ "url": "https://example.com/", "strategy": "mobile" }`. It accepts only public HTTP(S) domain URLs and returns Lighthouse results from Google. Scores are lab measurements and are not a promise of search ranking, conversions, or real-world performance.

## Deployment

Vercel deploys the connected repository. Pull requests should pass the GitHub Actions quality workflow and be checked on their Vercel preview before merging to `main`.

## Production notes

- Response throttling allows up to five audits per IP per ten-minute window per serverless instance. It is process-local and best-effort on serverless instances; before significant public traffic, use a shared rate limiter and enforce a Google API quota.
- Monitor PageSpeed API quotas and Google Cloud billing/usage limits.
- Re-run audits when decisions depend on scores because Lighthouse results can vary between runs.


## Frontend persistence and SEO

- Checklist selections and the light/dark preference are saved in browser local storage on the current device; they are not synced across browsers.
- The application adds WebSite and SoftwareApplication JSON-LD and updates the document title and description when a report is displayed. As this is a client-rendered Vite app, landing pages that need reliable indexing should eventually be prerendered or server-rendered.
- URL query parameters can prefill the target website and device for a fresh audit; they do not publish a durable, immutable copy of previous scores.
- Paystack is intentionally not enabled until a durable purchase record, PDF generation/storage, and one-time authorized download flow are implemented and configured. A webhook signature check alone is not sufficient to securely release a paid report.


## Durable reports, shared rate limiting and paid PDFs

Required Vercel environment variables: PAGESPEED_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PAYSTACK_SECRET_KEY and APP_BASE_URL. Set server secrets only in Vercel; never prefix them with VITE_ or commit their values. The audit endpoint fails closed when shared Redis limiting is not configured.

Apply supabase/migrations/202610170001_sitelift_audits_payments.sql to the dedicated SiteLift Supabase project. It creates the audits and audit_payments tables, enables RLS, revokes browser-role table access and creates a private audit-reports bucket. Do not apply this migration to another product's Supabase project.

POST /api/paystack/initialize records a pending ₦2,500 transaction and initializes Paystack checkout. /api/paystack/webhook validates the raw request HMAC-SHA512 signature, independently verifies transaction status/amount/currency with Paystack, generates a PDF and stores it in private Supabase Storage. GET /api/paystack/status?reference=... creates a one-hour signed URL only after payment is recorded as paid. Configure Paystack webhooks to https://sitelift.vercel.app/api/paystack/webhook.

Successful audits are persisted before response and return /audit/<uuid>. Static SEO landing pages are published at /check/mobile-speed-lagos and /tools/website-speed-checker, with canonical metadata, JSON-LD, internal links and sitemap entries.
