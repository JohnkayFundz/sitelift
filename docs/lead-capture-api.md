# SiteLift Lead Capture API

## Endpoint

`POST /api/leads/capture` accepts a JSON object up to 16 KiB. It stores a lead, a checklist email job, and a CRM sync outbox row in one PostgreSQL transaction through the `capture_sitelift_lead` RPC. A `201` means the records are durably queued, not that an email has been sent.

### Request

```json
{
  "email": "owner@example.com",
  "businessName": "Example Shop",
  "websiteUrl": "https://example.com/",
  "phone": null,
  "businessType": "retail",
  "auditId": "decb676a-e5fb-40eb-9ea6-e983b2a4840b",
  "source": "mobile-speed-lagos",
  "landingPage": "/check/mobile-speed-lagos",
  "marketingConsent": false
}
```

Headers:
- `Content-Type: application/json`
- Optional `Idempotency-Key`: 8–200 characters. The server hashes it before storage. Reuse with a different email, website, audit, or source returns `409`.
- Client IP is taken from Vercel's `x-real-ip` header or the socket fallback.

`websiteUrl` must be an HTTP(S) URL with a public DNS hostname, no credentials, no IP literal, no local/metadata hostname, and no non-standard port. It must match the exact hostname stored in the audit's `target_url` or `final_url`. The endpoint does not fetch the submitted URL.

### Responses

- `201 Created`: newly persisted lead; checklist status `queued`.
- `200 OK`: idempotent replay; existing durable lead; checklist status `already_queued`.
- `400 Bad Request`: invalid input, URL, audit correlation, or consent type.
- `404 Not Found`: audit does not exist.
- `405 Method Not Allowed`: non-POST method.
- `409 Conflict`: idempotency key reused with different identifying fields.
- `413 Payload Too Large`: request exceeds 16 KiB.
- `429 Too Many Requests`: Upstash limit exceeded; includes `Retry-After`.
- `503 Service Unavailable`: Upstash, Supabase, or persistence unavailable. The endpoint fails closed.

## Durable delivery

The SQL migration creates a transactional lead + delivery + CRM outbox function. The delivery worker claims jobs through `claim_sitelift_delivery_job` and finalizes only if its claim token still matches via `finish_sitelift_delivery_job`. It uses Resend's email API with a 12-second timeout, five maximum attempts, and bounded exponential backoff (60 seconds up to six hours). HTTP 4xx responses are permanent except 408/429; network errors, timeouts, 408, 429, and 5xx responses are retryable. Only fixed internal error codes are stored/logged.

The checklist email is transactional and is sent independently of `marketingConsent`. Marketing consent is stored separately with a timestamp only when true; replays do not change an existing lead's consent. The CRM sync row is queued in the outbox but is not dispatched by this delivery helper.

## Environment

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (server only)
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`

Do not expose service-role or Resend keys through Vite `VITE_*` variables. Apply the SQL migration only after reviewing the local/remote migration ledger for the dedicated SiteLift project. Do not run migrations against production as part of code review.


## Scheduled worker invocation

Vercel Cron is configured to call `GET /api/cron/deliver-checklists` every five minutes. Set a high-entropy `CRON_SECRET` in the Vercel environment before enabling the deployment. The route requires the exact `Authorization: Bearer <CRON_SECRET>` header, processes at most ten jobs per invocation, and returns aggregate status counts only. If `CRON_SECRET` is missing, it returns `503`; invalid credentials return `401`. Do not expose this secret in frontend variables or logs.
