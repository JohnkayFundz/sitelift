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

- Response throttling in the API route is process-local and best-effort on serverless instances; it is not a substitute for a distributed rate limiter or a billing quota.
- Monitor PageSpeed API quotas and Google Cloud billing/usage limits.
- Re-run audits when decisions depend on scores because Lighthouse results can vary between runs.
