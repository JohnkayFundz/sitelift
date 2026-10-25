# SiteLift CRM Outbox Synchronization

> **Status: NOT VERIFIED — RELEASE HOLD. The Client Engine repository inspection has not identified a general-purpose inbound lead endpoint that implements the SiteLift request contract.**

> **Release gate:** Do not configure or enable CRM delivery, provision credentials, apply migrations, deploy, or merge based on this documentation change. The destination route, authentication model, payload mapping, idempotency behavior, and response contract must be verified from the receiving implementation first.

## Scope and release posture

Lead capture writes the lead and a `sitelift_crm_sync` outbox row in the same database transaction. The worker in `api/cron/sync-crm.js` delivers queued rows to the configured JohnKay Client Engine integration endpoint. Committing this code does not apply the migration, configure secrets, activate the Vercel cron, or deploy production. Release remains **HOLD** until those steps are separately reviewed and authorized.

## Contract validation findings

A read-only inspection of the JohnKay Client Engine repository found a CRM lead validation schema and a `sync-hubspot` Supabase Edge Function, but did not identify a general-purpose inbound endpoint matching the SiteLift contract. The HubSpot function imports HubSpot records into the Client Engine; its existence does not establish that it accepts SiteLift's payload.

The inspected Client Engine lead schema in `src/lib/validation.ts` expects a flat object with snake_case fields. It requires `company` and `status`; `status` must be one of `New Lead`, `Contacted`, `Replied`, `Interested`, `Proposal Sent`, `Won`, or `Lost`. Fields such as `email` and `website` are optional in that UI schema. This schema is evidence of the frontend's lead shape, not proof that an HTTP receiver applies it to inbound requests.

### Known structural and authentication differences

- **Nested camelCase vs. flat snake_case:** SiteLift sends `lead.businessName`, `lead.websiteUrl`, and `lead.businessType` nested under `lead`. The Client Engine's inspected lead schema uses flat fields such as `company`, `website`, and `niche` or `opportunity_type`. An explicit mapping is required; do not assume these fields are interchangeable without confirming their semantics.
- **Required status is absent:** SiteLift does not currently include a top-level `status` in its outbound payload, while the inspected Client Engine `leadSchema` requires it. The receiver contract must define and validate a safe default, likely `New Lead`, or SiteLift must send an agreed status if the receiver explicitly requires it.
- **Other fields need mapping:** SiteLift sends `source`, `acquisitionSource`, and `audit.id`. The inspected lead schema has `source`, but no direct equivalent for `acquisitionSource` or `audit.id`. Decide how to preserve acquisition attribution and audit linkage without overwriting distinct meanings or silently discarding data.
- **Bearer authentication models differ:** SiteLift sends `Authorization: Bearer <CRM_API_KEY>`. The inspected `sync-hubspot` function extracts a bearer token and validates it as a Supabase user token. These credentials are not interchangeable merely because both use the Bearer scheme. A dedicated receiver must explicitly define server-to-server authentication and authorization.
- **Idempotency is not verified:** SiteLift sends the outbox UUID in both `idempotencyKey` and the `Idempotency-Key` header. The inspected Client Engine sources do not establish receiver-side deduplication for either value.
- **Response semantics are not verified:** SiteLift treats any 2xx as success and classifies network errors, timeouts, HTTP 408/425, HTTP 429, and 5xx as retryable; other 4xx responses are permanent. The Client Engine receiver's actual status codes and response body contract have not been established.

The absence of a matching receiver in the inspected repository does not prove that no separate or unpublished service exists. Confirm the intended endpoint from its implementation before claiming compatibility.

## Required receiver-side contract before integration

Before configuring `CRM_API_URL` or enabling delivery, document and verify all of the following:

1. **Endpoint identity:** Exact HTTPS URL and route, supported HTTP method, request-size limits, and content type.
2. **Authentication and authorization:** Exact bearer credential format, server-side verification procedure, required permissions, and a clear distinction between service credentials and end-user Supabase tokens.
3. **Request schema:** Required fields, data types, maximum lengths, nullability, unknown-field policy, and property casing. Specify a stable mapping for business name, website, business type, acquisition source, audit ID, and owner assignment.
4. **Lead defaults and validation:** Define the required `status` value or explicitly require SiteLift to provide it. Document validation rules for email, website, business name, and other accepted properties.
5. **Idempotency:** Accept `Idempotency-Key` (and define whether the body `idempotencyKey` must match it); scope key uniqueness, retention, concurrent duplicate handling, and replay behavior. Repeated delivery of the same job must not create duplicate leads.
6. **Success responses:** Define which 2xx statuses indicate durable creation or an already-processed idempotent replay. If a response identifier is returned, document its field name and type.
7. **Error responses and retries:** Define status codes and machine-readable error shapes for invalid payloads, authentication failures, authorization failures, rate limits, conflicts, and transient server errors. Align these with SiteLift's retry policy.
8. **Ownership and auditability:** Define which Client Engine owner receives the lead, how SiteLift source attribution is preserved, and how the audit reference is retained.
9. **Non-production verification:** Demonstrate contract tests against an isolated non-production receiver, including duplicate requests, invalid payloads, expired/invalid credentials, timeout-after-commit behavior, rate limiting, and retryable server errors.

No receiver contract should be inferred from the Client Engine frontend schema or the HubSpot import function alone.

## Destination contract currently emitted by SiteLift

The worker currently sends a JSON `POST` with the following shape:

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

Headers currently sent:

```http
Authorization: Bearer <CRM_API_KEY>
Content-Type: application/json
Idempotency-Key: <outbox UUID>
```

The receiver should treat the idempotency key as an idempotency key and return a documented 2xx response only after successful durable processing or an equivalent idempotent replay. An optional response JSON identifier is stored when one of `externalRecordId`, `recordId`, or `id` is a string no longer than 200 characters. The response body is never logged. This is the **sender's current contract proposal**, not a verified Client Engine API contract.

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

Do not expose any of these as `VITE_*` variables. Keep credentials out of logs and commit history. This documentation update does not configure or provision any environment variable or secret.

## Scheduling and rollout

`vercel.json` defines a daily 09:15 UTC schedule for `/api/cron/sync-crm`, alongside the checklist delivery schedule at 09:00 UTC. This daily cadence is compatible with Vercel Hobby's once-per-day cron restriction, but it can introduce substantial delivery delay; more frequent schedules require a plan/provider that supports them. Vercel Cron runs production deployments only, so the configuration is not active until a production deployment.

The migration `20261025130000_sitelift_crm_sync_worker.sql` must be reviewed against the actual dedicated SiteLift migration ledger and applied through the approved migration workflow. It has **not** been executed by this change. Do not apply it to any production or unrelated Supabase project as part of code review. Before release, verify the receiver contract, credentials, migration history, retry behavior, and monitoring in an isolated non-production environment.

## Documentation-only change boundary

This update is limited to `docs/crm-sync.md`. It must not change functional code, migrations, environment configuration, credentials, or tests. Automated test results from prior commits are not a substitute for receiver contract tests, and this documentation-only commit does not itself execute or modify the test suite.
