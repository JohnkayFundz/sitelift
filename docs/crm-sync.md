# SiteLift CRM Outbox Synchronization

## Scope and release posture

Lead capture writes the lead and a `sitelift_crm_sync` outbox row in the same database transaction. The worker in `api/cron/sync-crm.js` delivers queued rows to the configured JohnKay Client Engine integration endpoint. Committing this code does not apply the migration, configure secrets, activate the Vercel cron, or deploy production. Release remains **HOLD** until those steps are separately reviewed and authorized.

## Destination contract

Configure `CRM_API_URL` as the full HTTPS endpoint that accepts a JSON `POST`, and `CRM_API_KEY` as a server-only bearer credential. The request body is:

```json
{
  "source": "sitelift",
  "idempotencyKey": "<outbox UUID>",
  "lead": {
    "email": "owner@example.com",
    "businessName": "Example Shop",
    "websiteUrl": "https://example.com/",
    "businessType": "retail"
  },
  "audit": { "id": "<audit UUID>" },
  "acquisitionSource": "mobile-speed-lagos"
}
```

The receiver should treat `idempotencyKey` as an idempotency key and return 2xx for a successful create/upsert. An optional response JSON identifier is stored when one of `externalRecordId`, `recordId`, or `id` is a string no longer than 200 characters. The response body is never logged. Confirm the receiving Client Engine endpoint implements this contract before configuring the worker; the endpoint contract is not inferred from the frontend CRM tables.

## Claiming, retries, and delivery semantics

- `claim_sitelift_crm_sync` uses a row lock with `FOR UPDATE SKIP LOCKED`, increments `attempt_count`, and assigns a random claim token. This prevents concurrent workers from processing the same active lease.
- `finish_sitelift_crm_sync` updates a row only when the status is still `processing` and the claim token matches.
- Stale processing claims are eligible for recovery after 10 minutes. A stale claim at the attempt limit is marked failed.
- Each HTTP request has a 10-second timeout. The cron processes at most 3 records per invocation.
- The maximum is 5 claimed attempts. Network errors, timeouts, HTTP 408/425, HTTP 429, and 5xx are retryable. Other 4xx responses are permanent. Once attempts are exhausted, the row becomes `failed`.
- Backoff is persisted as `next_attempt_at`: 60 seconds, 2 minutes, 4 minutes, etc., capped at 6 hours. The worker does not sleep inside the request.
- Only fixed internal codes (for example `crm_rate_limited`) are persisted. Secrets, response bodies, and provider error messages are not logged.
- The outbox ID is also sent as `Idempotency-Key` to the destination. Since network failures can occur after the receiver commits, destination-side idempotency is required for safe at-least-once delivery.

## Environment variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — server only
- `CRON_SECRET` — high-entropy bearer secret used by both cron workers
- `CRM_API_URL` — full HTTPS endpoint, no embedded credentials
- `CRM_API_KEY` — server-only destination credential

Do not expose any of these as `VITE_*` variables. Keep credentials out of logs and commit history.

## Scheduling and rollout

`vercel.json` defines a daily 09:15 UTC schedule for `/api/cron/sync-crm`, alongside the checklist delivery schedule at 09:00 UTC. This daily cadence is compatible with Vercel Hobby's once-per-day cron restriction, but it can introduce substantial delivery delay; more frequent schedules require a plan/provider that supports them. Vercel Cron runs production deployments only, so the configuration is not active until a production deployment.

The migration `20261025130000_sitelift_crm_sync_worker.sql` must be reviewed against the actual dedicated SiteLift migration ledger and applied through the approved migration workflow. It has **not** been executed by this change. Do not apply it to any production or unrelated Supabase project as part of code review. Before release, verify the receiver contract, credentials, migration history, retry behavior, and monitoring in an isolated non-production environment.
