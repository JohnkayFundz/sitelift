# SiteLift → BizBoard CRM Ingress Specification

**Status: PROPOSED — NOT IMPLEMENTED OR VERIFIED**  
**Operational state: RELEASE HOLD; CRM synchronization disabled by default.**

This document defines a future server-to-server ingress contract. It is not evidence that BizBoard currently exposes this endpoint. Do not configure `CRM_API_URL`, provision credentials, enable `CRM_SYNC_ENABLED`, deploy, or apply database migrations on the basis of this proposal.

## 1. Architecture and trust boundary

SiteLift writes a lead and its CRM outbox record transactionally. A separately authenticated SiteLift worker may later deliver that outbox item to a dedicated BizBoard ingress endpoint.

The existing BizBoard `sync-hubspot` function is an inbound HubSpot importer that validates a Supabase user access token. It is not the proposed SiteLift receiver and must not be repurposed without a separate security review.

The future receiver must:
- Be a dedicated HTTPS server-to-server endpoint, separate from user-authenticated Supabase functions.
- Authenticate a high-entropy service credential independently of Supabase end-user sessions.
- Validate and normalize the complete request before creating records.
- Persist the idempotency key and lead mutation atomically.
- Return success only after durable persistence.
- Keep operational lead intake separate from marketing consent and marketing communications.

## 2. Proposed endpoint and authentication

| Property | Proposed contract |
|---|---|
| Method | `POST` |
| Route | Dedicated route to be selected and implemented in BizBoard; no live route currently verified |
| Content type | `application/json` |
| Transport | HTTPS only |
| Authentication | `Authorization: Bearer <service credential>` |
| Credential | Dedicated `CRM_API_KEY`, stored server-side in both systems |
| User token | Must not be a Supabase end-user access token |
| Authorization | Receiver verifies the service credential, scopes it to SiteLift lead-ingestion operations, supports rotation/revocation, and rejects missing/invalid credentials |

The receiver should compare credentials using a vetted constant-time secret-verification mechanism, avoid logging the credential, and return:
- `401 Unauthorized` for missing or invalid credentials.
- `403 Forbidden` for a valid credential without the required ingestion scope.

The exact route, secret storage mechanism, rotation process, and authorization implementation remain decisions for the receiver implementation review.

## 3. Request envelope

The sender's currently implemented payload is:

```json
{
  "source": "sitelift",
  "idempotencyKey": "outbox-uuid",
  "lead": {
    "email": "owner@example.com",
    "businessName": "Example Shop",
    "websiteUrl": "https://example.com/",
    "businessType": "retail"
  },
  "audit": {
    "id": "audit-uuid"
  },
  "acquisitionSource": "mobile-speed-lagos"
}
```

Headers:

```http
Authorization: Bearer <CRM_API_KEY>
Content-Type: application/json
Idempotency-Key: <same outbox UUID as idempotencyKey>
```

The body and header idempotency values must match. The outbox UUID is stable across retries for the same delivery job.

## 4. BizBoard field mapping

The receiver should validate and explicitly map the SiteLift envelope into the BizBoard lead model. Proposed mapping:

| SiteLift field | BizBoard field | Rule |
|---|---|---|
| `lead.businessName` | `company` | Required; trim and validate before insert |
| (receiver default) | `status` | Set to `New Lead` when no separately agreed status is supplied |
| `lead.email` | `email` | Validate; preserve normalized contact email |
| `lead.websiteUrl` | `website` | Validate URL under BizBoard policy |
| `lead.businessType` | `niche` | Map only after agreeing that the business-type taxonomy matches |
| `source` | `source` or dedicated source field | Preserve the literal originating system value `sitelift` |
| `acquisitionSource` | Dedicated acquisition attribution field | Do not overwrite the distinct system/source field |
| `audit.id` | Dedicated SiteLift audit reference/association | Preserve as a foreign reference; do not discard or mislabel as a CRM lead ID |

The currently inspected BizBoard lead schema requires `company` and `status`; its accepted status values include `New Lead`. The default in this specification is therefore `New Lead`, not a claim that the existing frontend schema implements an inbound default.

Fields not present in the sender's current payload (including contact phone/WhatsApp) must not be fabricated. Any future additions require a versioned contract and corresponding validation/tests.

## 5. Consent preservation and purpose limitation

Marketing consent is not implied by:
- Submitting a SiteLift audit or checklist request.
- Creating an operational CRM lead.
- Synchronizing a lead to BizBoard.
- Having an email address or telephone number.

**Current implementation gap:** the SiteLift CRM worker does not currently select or transmit `marketing_consent` or `consent_recorded_at`. Therefore the current request contains no consent evidence. The receiver must treat absent consent as **false / not granted** and must not enroll such records in marketing campaigns.

Before any consent-aware integration is enabled, a reviewed contract version must explicitly transmit:
- `marketingConsent`: boolean, sourced from the stored SiteLift consent field.
- `consentRecordedAt`: ISO-8601 timestamp when consent is true; null when false.

Receiver rules:
1. Reject inconsistent pairs (true without a valid timestamp; false with a purported affirmative timestamp) or normalize them according to an agreed strict schema.
2. Store consent evidence separately from operational lead status and acquisition attribution.
3. Never upgrade false, absent, or unknown consent to true.
4. Do not use operational lead synchronization as marketing authorization.
5. Preserve source and timestamp for auditability; honor later revocation through a separately defined consent update process.

This requires sender implementation and contract tests before activation. It is not implemented by the current worker.

## 6. Idempotency and transaction semantics

The receiver must require `Idempotency-Key` and verify it equals body `idempotencyKey`.

Recommended persistence:
- A receiver-side idempotency table with a unique constraint on (source, idempotency_key).
- A request-body hash and durable result/record ID stored in the same transaction as lead creation.
- Concurrent requests with the same key serialize through the unique constraint/transaction.
- Same key + same canonical request returns the original result without creating a second lead.
- Same key + different canonical request returns `409 Conflict`; never silently mutate the existing lead.
- Retention must exceed the sender's maximum retry/recovery window and be documented.

The outbox sender is at-least-once because a timeout can occur after the receiver commits. Sender retries are safe only when the receiver implements this idempotency contract.

## 7. Response contract

A successful response must be sent only after the lead and idempotency result are durably committed.

**New lead — proposed `201 Created`:**

```json
{
  "success": true,
  "externalRecordId": "bizboard-lead-uuid",
  "idempotencyKey": "outbox-uuid",
  "replayed": false
}
```

**Previously committed identical request — proposed `200 OK`:**

```json
{
  "success": true,
  "externalRecordId": "bizboard-lead-uuid",
  "idempotencyKey": "outbox-uuid",
  "replayed": true
}
```

The response identifier must be a stable string no longer than 200 characters. These response shapes are proposals; the current SiteLift worker only extracts `externalRecordId`, `recordId`, or `id` and currently treats any 2xx as success. Before enabling delivery, align the sender with the receiver's exact success schema and require a valid durable record identifier if the receiver contract promises one.

## 8. Error contract and retry alignment

| HTTP status | Meaning | Sender treatment |
|---|---|---|
| `400` / `422` | Invalid or semantically invalid payload | Permanent failure; fix data/contract |
| `401` / `403` | Missing/invalid credentials or scope | Permanent failure; operator intervention |
| `409` | Idempotency key reused with different request | Permanent failure; investigate |
| `413` | Request too large | Permanent failure |
| `408` / `425` | Transient request/processing condition | Retry |
| `429` | Rate limited; include `Retry-After` where possible | Retry |
| `5xx` | Receiver unavailable or transient failure | Retry |

Return a small machine-readable error body (for example `{ "error": "invalid_payload", "requestId": "..." }`). The sender must not persist raw response bodies, credentials, or provider details. Align any future status-code changes with `classifyFailure` in the sender.

## 9. Non-production acceptance tests

Before changing the default-off feature flag, test against an isolated receiver and isolated database:

- Valid service credential accepted; missing, invalid, expired, and revoked credentials rejected.
- Required `company` validation and default `New Lead` behavior.
- Mapping of email, website, niche, source, acquisition attribution, and audit reference.
- Missing consent remains false; true consent requires timestamp; no implicit marketing enrollment.
- Same idempotency key and same payload returns the same record ID without duplicate creation.
- Concurrent duplicate submissions create exactly one lead.
- Same key with a different payload returns conflict.
- `201` and replay `200` are returned only after durable commit.
- Timeout-after-commit followed by retry does not duplicate the lead.
- `400`, `401`, `403`, `409`, `413`, `422`, `429`, and `5xx` behavior matches the sender's retry policy.
- Logs contain no bearer credential, raw request body, or provider response body.

## 10. Activation gate

CRM delivery remains disabled unless an authorized release explicitly sets `CRM_SYNC_ENABLED=true`. That flag is not to be set as part of this work.

Before any later activation, require:
1. Dedicated BizBoard receiver implementation and peer review.
2. Agreed route, service authentication, schema, ownership, consent, idempotency, and response contracts.
3. Sender/receiver contract tests passing in isolated non-production environments.
4. Explicit approval of secrets and environment scopes.
5. Separate approval for scheduler activation and deployment.
6. Fresh review of the migration ledger and database environment isolation.

**This specification does not create the receiver, configure credentials, run migrations, activate the worker, deploy, or authorize merging to production.**
