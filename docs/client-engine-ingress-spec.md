# Client Engine Inbound Integration Specification: SiteLift Leads

**Document status:** Draft for review --- NOT IMPLEMENTED\
**Release posture:** HOLD\
**Target repository:** `JohnkayFundz/BizBoard` (Client Engine)\
**Proposed repository path:** `docs/client-engine-ingress-spec.md`\
**Proposed endpoint:** `POST /api/integrations/sitelift/leads`\
**Scope:** Documentation/design only. This document does not authorize
code changes, database changes, secret provisioning, environment
changes, live requests, deployment, or merge.

------------------------------------------------------------------------

## 1. Purpose and principles

Define a dedicated server-side receiver for SiteLift lead submissions.
It must accept durable-outbox retries and translate SiteLift's
nested/camelCase payload into the Client Engine's flat snake_case lead
model.

Required properties:

1.  **Independent service authentication:** SiteLift authenticates as a
    machine integration, not as a signed-in Client Engine user.
2.  **Idempotent creation:** retries of the same logical delivery cannot
    create duplicate leads.
3.  **Atomic persistence:** the idempotency receipt and lead creation
    commit together, or neither commits.
4.  **Explicit schema translation:** inbound SiteLift fields are not
    assumed to match Client Engine fields.
5.  **Bounded, observable processing:** validate, rate-limit, redact
    logs, and return deterministic HTTP responses.
6.  **No implicit consent:** marketing consent is independent of lead
    intake and transactional communications.
7.  **Fail closed:** missing auth configuration, unavailable idempotency
    storage, or uncertain persistence must not be reported as successful
    creation.
8.  **Release remains HOLD** until implementation, contract tests, and a
    controlled integration test are reviewed and separately authorized.

This is a proposed contract, not evidence that the endpoint exists or
that the deployed Client Engine schema supports every field below.
Existing validation and persistence must be inspected during an
authorized implementation phase.

## 2. Proposed endpoint contract

  ------------------------------------------------------------------------
  Property                            Contract
  ----------------------------------- ------------------------------------
  Method                              `POST`

  Path                                `/api/integrations/sitelift/leads`

  Transport                           HTTPS only

  Request body                        `application/json; charset=utf-8`

  Authentication                      Dedicated SiteLift integration key
                                      in `Authorization: Bearer …`

  Idempotency                         Required `Idempotency-Key`; use a
                                      stable SiteLift outbox record ID

  Response                            JSON

  Maximum body size                   64 KiB proposed; enforce before JSON
                                      parsing

  Versioning                          Introduce a versioned path or
                                      explicit version field before
                                      incompatible changes

  User session                        Not required and must not substitute
                                      for integration authentication
  ------------------------------------------------------------------------

The route must be server-side. Never expose the integration key to
browser code, return it to callers, or require a Supabase user access
token as a substitute for integration authentication.

### 2.1 Required headers

``` http
POST /api/integrations/sitelift/leads HTTP/1.1
Host: <Client Engine API host>
Authorization: Bearer <dedicated SiteLift integration key>
Content-Type: application/json; charset=utf-8
Accept: application/json
Idempotency-Key: sitelift:<stable-outbox-record-id>
```

Authentication requirements:

-   Use a dedicated, high-entropy key for this integration only. It must
    be separate from `CRON_SECRET`, Supabase user tokens, HubSpot
    credentials, and all other credentials.
-   Store and validate it server-side. Prefer constant-time comparison
    of a hash or keyed verifier. Never log the raw key.
-   Missing, malformed, invalid, or revoked credentials return
    `401 Unauthorized`. If the service cannot safely determine its
    configured authentication state, a documented fail-closed `503`
    policy is also possible; choose one policy and test it.
-   Do not reveal whether a key exists or which validation step failed.
-   Do not accept credentials in query parameters, cookies, JSON body,
    or browser storage.
-   HMAC request signing with timestamp and replay window can be
    considered as a later hardening step, but requires a separately
    specified canonicalization and rotation contract.

### 2.2 Idempotency key rules

`Idempotency-Key` is required. SiteLift should send a stable,
sender-namespaced identifier such as `sitelift:<outbox-record-id>` and
reuse it for every retry of the same delivery.

-   Accept 1--200 printable ASCII characters, excluding control
    characters; reject invalid values rather than silently altering
    them.
-   Scope uniqueness by authenticated integration and operation,
    e.g. `(integration_id, operation, idempotency_key)`.
-   Store a digest of the canonical validated payload alongside the
    receipt.
-   Same key + same canonical payload: return `200 OK` with the original
    result and do not create another lead.
-   Same key + different payload: return `409 Conflict`; do not mutate
    the lead or receipt.
-   Do not use email, audit ID, or company name alone as the idempotency
    key.
-   If SiteLift lacks a stable outbox record ID, it may generate a UUID
    once and persist it with the outbox record; it must not generate a
    new key for each retry.

## 3. Inbound JSON schema

### 3.1 Example request

Illustrative values only; not real customer data or credentials.

``` json
{
  "email": "owner@example.com",
  "businessName": "Example Studio",
  "websiteUrl": "https://example.com",
  "businessType": "Fashion retail",
  "auditId": "audit_01HXYZEXAMPLE",
  "source": "sitelift",
  "landingPage": "https://sitelift.example/audit",
  "marketing_consent": false
}
```

### 3.2 Field definitions

  ----------------------------------------------------------------------------
  Field                 Required?         Type and           Notes
                                          validation         
  --------------------- ----------------- ------------------ -----------------
  `email`               Yes               String, trim       Reject invalid
                                          surrounding        values with
                                          whitespace,        `422`. Email
                                          validate format,   presence is not
                                          max 254 chars      consent.

  `businessName`        Yes               String, trimmed    Maps to
                                          length 1--200      `company`; reject
                                                             blank values.

  `websiteUrl`          No                String or `null`;  Maps to
                                          absolute           `website`. URL
                                          HTTP/HTTPS URL;    acceptance does
                                          reject             not authorize
                                          credentials,       server-side
                                          unsupported ports, fetching.
                                          localhost,         
                                          private/reserved   
                                          IP literals, and   
                                          oversized values   

  `businessType`        No                String or `null`;  Maps to `niche`.
                                          trim; max 120      Normalize only
                                          chars              through an
                                                             approved,
                                                             explicit
                                                             taxonomy.

  `auditId`             Conditional       Required for       Preserve as
                                          audit-originated   integration
                                          events; string     metadata; it is
                                          1--128 chars using not
                                          documented         authorization.
                                          identifier         
                                          characters         

  `source`              Yes               String enum;       Persist canonical
                                          initially accept   `sitelift`; do
                                          `sitelift` only    not allow
                                                             arbitrary source
                                                             impersonation.

  `landingPage`         No                String or `null`;  Preserve as
                                          absolute HTTPS URL metadata; do not
                                          preferred;         fetch it during
                                          validate and       ingestion.
                                          length-limit       

  `marketing_consent`   Yes               Boolean only; no   Applies only to
                                          coercion           marketing
                                                             communications.
                                                             `false` must
                                                             remain false and
                                                             must not prevent
                                                             lead intake.
  ----------------------------------------------------------------------------

Reject wrong scalar types, malformed JSON, invalid UTF-8, bodies over
the configured limit, and duplicate JSON keys if the parser can detect
them. Do not silently coerce values.

### 3.3 New-lead response

``` json
{
  "ok": true,
  "result": "created",
  "integration": "sitelift",
  "lead_id": "<internal-lead-id>",
  "idempotency_key": "sitelift:<stable-outbox-record-id>"
}
```

### 3.4 Replay response

``` json
{
  "ok": true,
  "result": "replayed",
  "integration": "sitelift",
  "lead_id": "<original-internal-lead-id>",
  "idempotency_key": "sitelift:<stable-outbox-record-id>"
}
```

Never return full internal database records, access tokens, stack
traces, or sensitive notes.

## 4. Mapping to the Client Engine flat lead model

The described Client Engine model includes `company`, `contact_name`,
`role`, `email`, `phone`, `website`, `instagram`, `niche`, `location`,
`source`, `status`, `deal_value`, `opportunity_type`, `next_follow_up`,
and `notes`. The mapping below is a proposal; actual accepted values and
persistence requirements must be confirmed before implementation.

  -----------------------------------------------------------------------------
  SiteLift inbound field  Client Engine field     Rule
  ----------------------- ----------------------- -----------------------------
  `businessName`          `company`               Trimmed business name

  `email`                 `email`                 Trim; normalize case only if
                                                  consistent with existing
                                                  policy

  `websiteUrl`            `website`               Validated URL or `null`

  `businessType`          `niche`                 Trimmed descriptive category;
                                                  controlled taxonomy mapping
                                                  only if agreed

  Constant                `source`                Canonical `sitelift`; do not
                                                  trust caller-supplied
                                                  arbitrary values

  Constant                `status`                `New Lead` on first creation;
                                                  never overwrite status on
                                                  replay

  Approved deterministic  `opportunity_type`      For example,
  mapping                                         `SiteLift Audit Follow-up`,
                                                  subject to approval; do not
                                                  derive uncontrolled business
                                                  logic from free text

  Not supplied            `contact_name`          Leave unset/`null`; do not
                                                  copy the business name into a
                                                  person's name

  Not supplied            `role`                  Leave unset/`null`

  Not supplied            `phone`                 Leave unset/`null`

  Not supplied            `instagram`             Leave unset/`null`

  Not supplied            `location`              Leave unset/`null`

  Not supplied            `deal_value`            Leave unset/`null`; never
                                                  invent a value

  Not supplied            `next_follow_up`        Leave unset/`null` unless the
                                                  existing schema requires an
                                                  approved default

  `auditId`,              `notes` or dedicated    Prefer structured metadata.
  `landingPage`, sender,  integration metadata    If only `notes` exists,
  schema version                                  append a bounded, clearly
                                                  labelled block without
                                                  overwriting user-authored
                                                  notes.
  -----------------------------------------------------------------------------

### 4.1 Suggested integration metadata

If the current schema supports a metadata field or related receipt
record, preserve:

``` json
{
  "integration": "sitelift",
  "external_audit_id": "audit_01HXYZEXAMPLE",
  "landing_page": "https://sitelift.example/audit",
  "idempotency_key": "sitelift:<stable-outbox-record-id>",
  "schema_version": 1
}
```

This does not authorize adding a database column or table. If no
dedicated metadata field exists, agree on a bounded notes convention or
separately review any schema change. Never store credentials or raw
authorization headers in metadata or notes.

### 4.2 Consent semantics

-   Persist `marketing_consent` only in designated consent fields, with
    source and timestamp only if the approved model supports them.
-   `false`, missing, or invalid consent must never become `true`.
-   Lead intake and CRM queueing must not depend on marketing consent.
-   Marketing consent is not blanket permission for unrelated processing
    or email.
-   Transactional communications require their own documented purpose
    and policy.
-   Do not invent a consent timestamp, wording, IP address, or evidence
    of affirmative action. If required, extend and approve the contract
    before enabling the integration.

## 5. Validation and ingestion pipeline

1.  **Method and transport:** HTTPS at the edge; require `POST`.
2.  **Body bounds:** enforce size limit before parsing; reject
    unsupported content types.
3.  **Authentication:** validate the dedicated integration key before
    expensive processing.
4.  **Rate limiting:** limit by integration identity and, where useful,
    source network. Return `429` with `Retry-After`; do not trust
    caller-supplied IP headers alone.
5.  **Parse:** strict JSON parsing; reject malformed JSON and invalid
    shapes.
6.  **Validate:** field rules, safe URL checks, enum restrictions, and
    strict boolean consent validation.
7.  **Canonicalize:** create a deterministic representation for the
    payload digest. Specify Unicode normalization and
    null-versus-omitted semantics. Do not hash arbitrary JSON
    serialization whose property order may vary.
8.  **Idempotency lookup:** find the receipt by integration, operation,
    and key.
9.  **Atomic write:** atomically create receipt and lead, or durably
    store an ingestion command for asynchronous processing.
10. **Respond:** only after the accepted result is durably recorded.
    Never return `201` because work was placed only in volatile memory.

Do not synchronously crawl websites, fetch audits, enrich leads, send
outbound email, or perform other network side effects inside the
ingestion transaction. Those activities belong in separate durable jobs
with independent retries and controls.

## 6. Idempotency and distributed-systems architecture

### 6.1 Persistence invariant

For each `(integration_id, operation, idempotency_key)`, there must be
at most one committed ingestion result and at most one lead created by
that ingestion. Enforce uniqueness at the datastore level or through an
equivalent atomic primitive. An application-level check-then-insert
without a uniqueness guard is insufficient.

An idempotency receipt should contain:

-   integration identity and operation;
-   idempotency key or safe digest;
-   canonical payload digest;
-   state such as `processing`, `completed`, or `failed_retryable`;
-   internal lead ID once committed;
-   first-seen and completion timestamps;
-   bounded non-sensitive result summary;
-   retention/expiry policy.

### 6.2 Preferred transaction strategy

When the lead and receipt share a transactional datastore:

1.  Begin transaction.
2.  Insert receipt under a unique constraint.
3.  If the key already exists, compare payload digests and return the
    prior result or `409`.
4.  Insert lead with status `New Lead` and mapped metadata.
5.  Mark receipt completed with the new lead ID.
6.  Commit.
7.  Return `201`.

If any step fails, roll back. When concurrent requests race on the
unique key, re-read the committed receipt and apply replay/conflict
rules.

### 6.3 If atomic lead + receipt writes are not possible

Use a durable inbox/command record as the authoritative accepted
operation. Enforce uniqueness at inbox insertion, then process
asynchronously with durable state transitions and idempotent lead
creation. Return `202 Accepted` only if asynchronous acceptance is
explicitly agreed with SiteLift and the command has been durably stored.
Do not claim the lead already exists. This alternative changes sender
semantics and must be approved before implementation.

### 6.4 Crash and retry behavior

  -----------------------------------------------------------------------
  Scenario                            Required behavior
  ----------------------------------- -----------------------------------
  Failure before durable write        Return retryable `5xx`; retry same
                                      key

  Transaction fails before commit     Roll back; retry same key

  Commit succeeds but response is     Retry returns `200` replay with
  lost                                original lead ID

  Concurrent same-key, same-payload   One creates; others replay after
  requests                            resolving uniqueness race

  Same key with changed payload       `409`; no mutation

  Temporary datastore failure         `503`; never claim success

  Worker crashes after durable        Retry from durable state; no second
  acceptance                          lead

  Receipt expires                     Retention must exceed maximum
                                      sender retry/replay window
  -----------------------------------------------------------------------

Agree the retention period with SiteLift's outbox retry policy. A
proposed starting point is at least 90 days, subject to
privacy/data-retention review. A stable audit ID may be a secondary
business-level duplicate signal, but should not silently replace the
idempotency key: one audit may legitimately produce distinct events.

## 7. HTTP status semantics

All responses should be JSON with a request/correlation ID. Do not
include stack traces, raw SQL errors, secrets, or unnecessary personal
data.

  ------------------------------------------------------------------------------
  Status                         Meaning                 Sender behavior
  ------------------------------ ----------------------- -----------------------
  `201 Created`                  New lead durably        Mark outbox delivery
                                 created synchronously   successful

  `200 OK`                       Same key and same       Mark successful; do not
                                 payload already         create another lead
                                 completed; original     
                                 lead ID returned        

  `202 Accepted`                 Optional asynchronous   Treat as accepted only
                                 mode; command durably   if explicitly supported
                                 stored, processing may  by the sender contract
                                 remain pending          

  `400 Bad Request`              Malformed JSON,         Do not retry unchanged
                                 unsupported content     request
                                 type, missing/invalid   
                                 required header, or     
                                 invalid framing         

  `401 Unauthorized`             Missing, invalid, or    Alert operator; avoid
                                 revoked integration     rapid automatic retries
                                 credential              

  `403 Forbidden`                Optional: authenticated Treat as
                                 integration lacks       policy/configuration
                                 operation permission    failure

  `409 Conflict`                 Key reused with a       Do not retry unchanged
                                 different canonical     combination;
                                 payload                 investigate

  `413 Payload Too Large`        Body exceeds configured Do not retry unchanged
                                 limit                   payload

  `415 Unsupported Media Type`   Unsupported content     Correct request
                                 type                    

  `422 Unprocessable Content`    Parsed request fails    Do not retry unchanged
                                 field/business          payload
                                 validation              

  `429 Too Many Requests`        Rate limit exceeded     Retry after
                                                         `Retry-After`, same key

  `500 Internal Server Error`    Unexpected internal     Retry with exponential
                                 failure                 backoff and jitter,
                                                         same key

  `503 Service Unavailable`      Storage or required     Retry with backoff;
                                 dependency unavailable, alert if sustained
                                 or approved fail-closed 
                                 configuration policy    

  `504 Gateway Timeout`          Timeout with uncertain  Retry same key;
                                 outcome                 idempotency resolves
                                                         uncertainty
  ------------------------------------------------------------------------------

The implementation must distinguish client errors from transient errors.
Never return `201` or a replay `200` unless the durable outcome is
known. If a timeout occurs after commit, the next retry must find the
receipt and return the original result.

### 7.1 Error body

``` json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "One or more fields are invalid.",
    "fields": {
      "email": "Must be a valid email address."
    }
  },
  "request_id": "<correlation-id>"
}
```

Use stable machine-readable codes. Do not echo credentials, full request
bodies, database details, or internal exception messages.

## 8. Security and privacy controls

-   HTTPS only and request-size limits at both edge and application
    layers.
-   Dedicated integration identity/key; rotation should allow a
    controlled overlap period, then revoke the old key.
-   Store secrets only in the approved server-side secret store after
    separate authorization. Never hard-code or commit them, or expose
    them in frontend bundles.
-   Never accept a Supabase user access token as proof that SiteLift is
    authorized. User sessions and machine integrations are different
    security principals.
-   Apply least privilege: this identity may create leads through this
    endpoint only; it may not read/export CRM data, administer users, or
    change settings.
-   Validate server-side even if SiteLift also validates.
-   Do not fetch `websiteUrl` or `landingPage` during ingestion. Later
    URL enrichment requires a separate SSRF-safe design with DNS/IP
    revalidation, redirect controls, egress restrictions, and timeouts.
-   Redact authorization headers, keys, request bodies, emails, and
    notes from routine logs. Log request ID, integration ID, status,
    latency, stable error code, and a non-reversible idempotency
    reference where appropriate.
-   Sanitize control characters to prevent log injection.
-   Set timeouts, concurrency limits, request quotas, and alert
    thresholds.
-   Do not allow caller-supplied source, status, deal value, ownership,
    or privilege fields to override server policy.
-   Review applicable privacy, consent, and retention requirements
    before launch.

## 9. Observability and operations

Emit structured events for request accepted/rejected, auth failure
(without raw key), validation rejection by field code, lead creation,
idempotent replay, idempotency conflict, transient persistence failure,
rate limit, and processing latency/retry counts.

Recommended metrics:

-   requests by status and integration;
-   new creates and replay rate;
-   validation/auth/conflict rejection rates;
-   `429`, `5xx`, and timeout rates;
-   persistence latency;
-   pending inbox/outbox count and age if asynchronous processing is
    used.

Alert on sustained `5xx`/`503`, unusual authentication failures,
elevated conflicts, growing backlog, and repeated retry exhaustion.
Monitoring must not expose personal data or credentials.

## 10. Contract and failure-injection test plan

Before implementation can be approved, tests must prove:

1.  Valid authenticated request creates one lead and returns `201`.
2.  Field mapping creates `company`, `email`, `website`, `niche`,
    canonical `source=sitelift`, `status=New Lead`, and agreed metadata.
3.  Missing, malformed, invalid, and revoked keys are rejected with no
    lead write.
4.  Supabase user session tokens alone do not authenticate the
    integration.
5.  Missing/malformed idempotency key is rejected.
6.  Same key + same payload returns `200` and original lead ID without a
    second insert.
7.  Same key + changed payload returns `409` without mutation.
8.  Concurrent duplicate requests produce exactly one lead.
9.  Simulated response loss after commit followed by retry returns
    original result.
10. Failure before commit creates neither lead nor completed receipt.
11. Failure after durable async acceptance is recoverable without
    duplicate creation.
12. Invalid email, blank business name, unsafe URL, wrong scalar types,
    malformed JSON, oversized body, and invalid consent are rejected.
13. `marketing_consent=false` is preserved and does not block intake.
14. Arbitrary source/status/deal-value fields cannot override
    server-controlled values.
15. Rate limiting returns `429` and valid `Retry-After`.
16. Transient storage failure returns retryable `5xx` and never falsely
    reports success.
17. Logs/errors contain neither credentials nor full request bodies.
18. Key rotation and revocation work as designed.
19. Receipt retention does not permit a legitimate retry to create
    duplicates.
20. Existing Client Engine lead creation paths and validation remain
    compatible.

Use isolated fakes or separately approved non-production test resources.
Do not use a production endpoint, production database, or live
credentials for this test plan.

## 11. Implementation sequence after separate authorization

1.  Inspect and confirm the actual Client Engine lead schema,
    validation, and persistence path.
2.  Resolve open decisions in Section 12 and approve the contract with
    SiteLift.
3.  Implement the server-side route, integration authentication, strict
    validation, idempotency persistence, and mapping.
4.  Add unit, contract, concurrency, and failure-injection tests.
5.  Review privacy, key rotation, observability, rate limits, and
    retention.
6.  Deploy only to an explicitly approved isolated staging environment
    after staging authorization/configuration is granted.
7.  Run controlled end-to-end tests with test-only credentials and
    synthetic data.
8.  Verify SiteLift recognizes `201` and `200`, retries only transient
    failures, and reuses the same key.
9.  Conduct security/operational review and document rollback/key
    revocation.
10. Obtain explicit release authorization before production
    configuration, deployment, migration, or merge.

This document authorizes none of these actions.

## 12. Open decisions before implementation

-   **Runtime/route:** Which server-side Client Engine runtime and
    routing convention will host the endpoint?
-   **Persistence:** Which existing write path/schema is authoritative?
    Is an integration receipt/inbox table required?
-   **Atomicity:** Can lead creation and idempotency receipt share a
    transaction?
-   **Authentication:** What is the approved secret storage/rotation
    process? Is bearer API key sufficient, or is HMAC required?
-   **Sender identity:** Which exact SiteLift outbox ID is stable across
    retries, and what is its format?
-   **Payload:** Confirm actual SiteLift field names, nullability,
    length limits, and whether `auditId` is always present.
-   **Opportunity taxonomy:** Confirm allowed `opportunity_type` values
    and classification for audit leads.
-   **Consent:** Identify approved storage fields and evidence
    requirements.
-   **Business duplicate policy:** Is audit ID unique per event, and
    should it be a secondary uniqueness constraint?
-   **Retry policy:** Align `429`/`5xx`/timeout behavior, maximum
    attempts, and backoff with SiteLift's outbox.
-   **Retention:** Agree receipt and metadata retention with retry
    horizon and privacy policy.
-   **Sync/async:** Decide whether to create synchronously (`201`) or
    accept a durable command (`202`); do not mix semantics.
-   **Ownership:** Identify operational owner, alert destination, and
    incident procedure without putting credentials in this document.

Do not silently resolve these assumptions in production code.

## 13. Acceptance criteria and release gate

The design is ready for implementation review only when:

-   compatibility and persistence decisions are resolved;
-   SiteLift and Client Engine owners approve the request/response
    schema;
-   uniqueness is enforced at the persistence layer;
-   the dedicated integration authentication is reviewed;
-   the test plan passes in an isolated environment;
-   consent, logging, retention, and key rotation are reviewed;
-   no production side effects occurred during design or test
    preparation.

**Release status: HOLD.** Passing local SiteLift tests, lint, and build
does not prove that the Client Engine receiver exists or accepts this
contract. This document authorizes no production request, Supabase
query/migration, secret provisioning, environment change, deployment, or
merge.

------------------------------------------------------------------------

## Appendix A --- Illustrative OpenAPI-style contract

Review aid only; this excerpt is not a validated OpenAPI document or
implementation artifact.

``` yaml
POST /api/integrations/sitelift/leads:
  security:
    - SiteLiftIntegrationBearer: []
  headers:
    Idempotency-Key:
      required: true
      schema:
        type: string
        minLength: 1
        maxLength: 200
  requestBody:
    required: true
    content:
      application/json:
        schema:
          type: object
          required:
            - email
            - businessName
            - source
            - marketing_consent
          properties:
            email: { type: string, format: email, maxLength: 254 }
            businessName: { type: string, minLength: 1, maxLength: 200 }
            websiteUrl: { type: [string, "null"], format: uri }
            businessType: { type: [string, "null"], maxLength: 120 }
            auditId: { type: [string, "null"], maxLength: 128 }
            source: { type: string, enum: [sitelift] }
            landingPage: { type: [string, "null"], format: uri }
            marketing_consent: { type: boolean }
  responses:
    "201": { description: New lead durably created }
    "200": { description: Idempotent replay of an existing result }
    "400": { description: Malformed request }
    "401": { description: Integration authentication failed }
    "409": { description: Idempotency key reused with a different payload }
    "413": { description: Request body too large }
    "415": { description: Unsupported content type }
    "422": { description: Field or business validation failed }
    "429": { description: Rate limited; inspect Retry-After }
    "500": { description: Unexpected internal failure }
    "503": { description: Required service unavailable }
```

Validate the excerpt against the chosen OpenAPI version before adoption;
nullable-type syntax differs between versions.