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

### Preview database safety

The server-side Supabase client refuses database access when `VERCEL_ENV=preview` and the configured URL points to the SiteLift production project (`jnuqpijilwmhefbtjimx.supabase.co`). The same guard is applied to audit persistence. This is a fail-closed safety barrier, not a separate database: Preview database-backed features will return an unavailable response until Preview is configured with an independent Supabase project. Production deployments are unaffected by this Preview-only guard.

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

The migration files under `supabase/migrations/` preserve the recorded historical production versions. Do not manually replay the initial audits/payments, download-token, processing-claim, or status-fix migrations against the existing production database, and do not apply them to another product's Supabase project. The active-checkout unique index is a separate forward-only migration (`202610250001_sitelift_active_checkout_unique_index.sql`) that must only be applied after migration history, environment isolation, and a fresh duplicate-active-checkout check have been reviewed.

POST /api/paystack/initialize records a pending ₦2,500 transaction and initializes Paystack checkout. /api/paystack/webhook validates the raw request HMAC-SHA512 signature, independently verifies transaction status/amount/currency with Paystack, generates a PDF and stores it in private Supabase Storage. GET /api/paystack/status?reference=... is a read-only status lookup and never reconciles payments or creates signed URLs. The customer callback intentionally POSTs to /api/paystack/verify to reconcile a pending payment and obtain a one-hour signed download URL. Configure Paystack webhooks to https://sitelift.vercel.app/api/paystack/webhook.

Successful audits are persisted before response and return /audit/<uuid>. Static SEO landing pages are published at /check/mobile-speed-lagos and /tools/website-speed-checker, with canonical metadata, JSON-LD, internal links and sitemap entries.
