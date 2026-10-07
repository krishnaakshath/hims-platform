# SP8: ABDM (ABHA) and NHCX Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the HIMS to India's national health stack:
- **ABHA (ABDM milestone M1).** Staff can:
  - create an ABHA by Aadhaar OTP;
  - verify and link an existing ABHA by ABHA-number, mobile or Aadhaar OTP;
  - pick or create an ABHA address;
  - fetch the ABHA profile;
  - receive "Scan & Share" profile shares at the registration desk.

  All of it runs behind an `AbdmGateway` interface. Aadhaar numbers and OTPs pass through to ABDM encrypted and are never stored, logged, audited or echoed.
- **NHCX.** NHCX means the National Health Claims Exchange, which runs on the HCX protocol. SP8 adds:
  - an `NhcxClaimGateway` that plugs into SP7's `ClaimGateway`;
  - a JWE protocol client with callbacks, status polling and retries;
  - FHIR bundles built from the SP7 snapshots, using NRCeS profiles for CoverageEligibility, Claim (pre-auth and claim), Communication and PaymentNotice;
  - an eligibility check that replaces the simulated one;
  - an admin connection page.

  When nothing is configured, every capability says "not configured". Mocks exist only behind `ABDM_USE_MOCKS=1` outside production.

**Architecture:**
- **Pure and client-safe code** lives under `src/lib/abdm/` (ABHA), `src/lib/nhcx/` (protocol) and `src/lib/fhir/nhcx/` (FHIR R4 builders, parsers and a structural validator). It covers constants, header builders, FHIR builders and parsers, the validator, status mappings and redaction.
- **Server-only adapters** perform HTTP and crypto. They get their configuration only from `readAbdmConfig()` / `readNhcxConfig()`.
- **Every network call happens outside a database transaction.** An NHCX claim submission inserts an *outbox* row in the same transaction as SP7's `claim_submissions`. The send happens after commit (`after()` from `next/server`), and a cron sweep retries it.
- **Inbound callbacks** go to one session-less route. It runs these checks in order, each before the next stage:
  1. IP allowlist;
  2. rate limit;
  3. bearer-JWT signature;
  4. JWE decrypt with our private key;
  5. protocol-header checks;
  6. `api_call_id` replay dedupe.

  Then it records the result and returns fixed bodies.
- **NHCX results never change claim status or money by themselves.** They are recorded (exchange row, plus SP7 `claim_events` `note` rows written by "NHCX gateway") and offered to an RCM user as pre-filled SP7 actions, which the user confirms (ruling 6).

**Tech Stack:**
- Next.js 16 App Router: route `params` and page `searchParams` are `Promise`s; `src/proxy.ts` excludes `/api`; `after` comes from `next/server`.
- drizzle-orm 0.45 with node-postgres; Postgres 15; zod v4.
- `jose` ^6 (already a dependency) for JWE and JWT. `node:crypto` for RSA-OAEP-SHA1 ABHA field encryption, `X509Certificate` and AES-256-GCM at rest.
- `@upstash/redis` and `@upstash/ratelimit` (already dependencies) for the token cache, flow store and rate limits.
- vitest, jsdom and Testing Library; lucide-react.
- **No new runtime dependency.** The Swasth `hcx-integrator-sdk` is not used (ruling 3).

**Spec:** `docs/superpowers/specs/2026-10-07-indian-hims-design.md`. Sections 1–4, 6 and 7 are binding, and this plan implements sub-project 8, "ABDM / NHCX integration (needs 1, 6, 7). ABHA verify/link/consent artefacts, NHCX FHIR bundles and gateway submission/status callbacks (mock + real adapter)". The following spec text applies:
- §3 ABHA: "verification/linking goes through the ABDM gateway behind an interface with a **sandbox/mock implementation by default**; real credentials … are supplied per deployment. Without them the UI states 'not connected'." §3 "No fake data in production … gateways return 'not configured' unless a real credential exists; mocks only behind an explicit env flag". This plan reads the second rule as narrowing the first: the mock is the default only in development and only with the flag (ruling 1).
- §3 NHCX: "FHIR R4 Claim / CoverageEligibilityRequest / Claim(preauth) bundles generated per the NHCX profiles, behind a gateway interface with a mock; real submission needs NHA onboarding."
- §3 Aadhaar: "never logged or placed in URLs/exports/FHIR".
- §7 Risks: "Real ABDM/NHCX onboarding needs NHA registration (owner/legal)".

**Depends on (all must be merged to `main` before Task 1; see Step 0):**
- **SP1** (merged):
  - `patients.abhaNumber|abhaAddress|abhaUnavailableReason`, with the unique constraints `patients_abha_number_unique` and `patients_abha_address_unique`;
  - `normalizeAbhaNumber`, `isValidAbhaNumber`, `formatAbhaNumber`, `normalizeAbhaAddress`, `isValidAbhaAddress` (`src/lib/india/abha.ts`);
  - `isValidAadhaar`, `normalizeAadhaar`, `containsAadhaarLike`, `redactAadhaarLike` (`src/lib/india/aadhaar.ts`);
  - `identityAuditEntries`, `IdentitySnapshot` (`src/lib/patient-identity.ts`);
  - `updatePatientProfile` (`src/lib/queries/patient-profile.ts`);
  - `registerPatient` (`src/lib/queries/patient-registration.ts`);
  - `NationalIdSection.tsx` (`ABDM_HINT`);
  - `src/lib/fhir/identifier-systems.ts` (`ABHA_NUMBER_SYSTEM`, `ABHA_ADDRESS_SYSTEM`, `uhidSystem`, all provisional);
  - `src/lib/crypto.ts` (`encryptSensitive` / `decryptSensitive`);
  - `logAudit(session, action, patientId, details, executor)`;
  - `logIntegrationEvent` (`src/lib/patient-portal-audit.ts`), the session-less audit pattern;
  - `getRedis()` (`src/lib/cache.ts`);
  - `Ratelimit` usage in `src/lib/rate-limit.ts`;
  - `tests/lib/no-aadhaar-leak.test.ts` (`EXPORT_PATHS`), `tests/lib/no-credential-leak.test.ts`;
  - `tests/db/migration-sql.ts` (`readMigration`, `idempotencyProblems`, `missingColumns`);
  - `REGISTRATION_ROLES`, `IDENTITY_VERIFY_ROLES`.
- **SP3:** `WriteExecutor`, `readJsonBody`, `isoDateSchema`, `todayIsoIn`, `istDateOf`, `providers` with NMC/SMC registration.
- **SP4:** invoices and `invoice_lines` (already flattened into SP7 `SnapshotItem`), `MAX_DOCUMENT_PAISE`, `parseRupeesToPaise` / `formatPaise`.
- **SP5:** `streamPrivateBlob`, and a byte reader `getPrivateBlobBytes(url): Promise<Uint8Array | null>`. If SP5 exports only streams, Task 11 adds this reader to `src/lib/blob-store.ts`.
- **SP6:** `FHIR_SYSTEM_URI`, `fhirSystemFor(binding)`, `isSampleVersion(version)`, `CodeSystemKind` (`src/lib/coding/code-systems.ts`), `codingFor`.
- **SP7** (`docs/superpowers/plans/2026-10-07-sp7-rcm-claims.md`). Its rulings 4, 6, 9 and 10 bind here:
  - the `ClaimGateway`, `SubmissionPackage`, `GatewaySubmitResult`, `getClaimGateway(channel, registry?)` and `nhcxGatewayStub` (`src/lib/rcm/gateway.ts`);
  - `ClaimSnapshot`, `PreauthSnapshot`, `CodedEntry`, `SnapshotItem`, `SnapshotDocument`, `PayerRef`, `canonicalJson` (`src/lib/rcm/snapshot.ts`), and `sha256Hex`;
  - `SUBMISSION_CHANNELS` (includes `nhcx`), `CHANNEL_LABEL`, `POLICY_RELATIONSHIPS`, `CLAIM_DOCUMENT_KINDS`, `CLAIM_TYPES`;
  - `RCM_ERROR_MESSAGE.gateway_not_configured`;
  - tables `payer_profiles` (`nhcxParticipantCode`, `defaultChannel`), `patient_policies`, `preauths`, `preauth_events` (snapshot), `rcm_queries`, `claims`, `claim_submissions`, `claim_dispatches`, `claim_events`, `claim_documents`, `billing_settings.rohini_id|hfr_id`;
  - `lockPatientBilling`, `submitClaimVersion` with `SubmissionDeps.gateway` and `defaultSubmissionDeps`, `applyClaimUpdate`, `applyPreauthAction`, `recordSettlement`;
  - `getHospitalIdentifiers()`, `RCM_ROLES`, `POLICY_READ_ROLES`, the `rcm` role;
  - the `SP7_WRITE_GATES` harness array;
  - `PatientPoliciesPanel`, the claim workspace `/rcm/claims/[id]`, the pre-auth detail page.

**External specifications relied on (fetched 2026-10-08; cite these in code comments, never others):**

| # | Source | Version / date | Used for |
|---|---|---|---|
| S1 | NHA docs repo `https://github.com/nha-in/docs` (published at `https://docs.abdm.gov.in`): `catalogue/hiecm/openapi/v3/hiecm-gateway.yaml`, `hiecm-m1.yaml`, `hiecm-scan-and-register.yaml`; pages `site/docs/hiecm/v3/api/m1`, `concepts/encryption.mdx`, `concepts/callback-authenticity.mdx`, `getting-started/going-live.mdx`, `build-it-well.mdx`, `resources/test-cases/m1.mdx` | commit `e3ddb9b` (2026-10-07); OpenAPI 3.1.1 `version: abdm-v3` | ABDM gateway session, ABHA V3 M1 paths, scopes, headers and encryption, Scan & Share, certification rules |
| S2 | Same repo, mirror of the NHCX portal `catalogue/openapi/.raw/nhcx-site-2026-09-14/swagger/*.json` (byte-identical to `https://hcxsbx.abdm.gov.in/#/documents`; FAQ PDF sha256 matched) | 2026-09-14 | NHCX `/v1/...` API paths and the participant service |
| S3 | Same repo, explanatory "atom" pages `catalogue/nhcx/**` | 2026-10-07 | NHCX hosts, `bearer_auth` header, JWE `RSA-OAEP-256`, callback rules. **Secondary**: the `nha-in` GitHub org is unverified (created 2026-08-25). Every fact taken only from S3 is marked UNVERIFIED |
| S4 | HCX protocol spec `https://github.com/hcx-project/hcx-specs` tag `v0.8`, `API Definitions/openapi_hcx.yaml` (info.version 0.8.0), `openapi_hcx_registry.yml` | v0.8 | Protocol headers, `x-hcx-status` values, JWE envelope `{"payload": "<compact JWE>"}`, 202 `SuccessResponse`/`ErrorResponse`, error codes |
| S5 | NRCeS "FHIR Implementation Guide for ABDM" `https://nrces.in/ndhm/fhir/r4/` (HCX profiles `hcx-profile.html`), package `ndhm.in` | **6.5.0**, built 2025-05-08 | Profile canonical URLs, required elements, CodeSystems/ValueSets, official example bundles |
| S6 | Swasth `https://github.com/Swasth-Digital-Health-Foundation/integration-sdks` (JS SDK `hcx-integrator-sdk` 1.0.7/1.0.8) | last push 2024-11-08 | Reference only (`processOutgoingRequest` / `processIncoming` shape). Not a dependency |

> `docs.hcxprotocol.io` redirected to an unrelated domain on 2026-10-08. Never link to or fetch it in code, docs or tests. `sandbox.abdm.gov.in` pages render only with JavaScript and could not be read. `nrces.in/nhcx/` returns 404 (the NHCX profiles are inside the ABDM IG, S5).

## Global Constraints

- **Read `AGENTS.md` first.** Before writing any route or page, read the matching guide in `node_modules/next/dist/docs/` (for `after`, read `01-app/03-api-reference/04-functions/after.md`). Route context is `{ params: Promise<{ … }> }`; page props are `{ params: Promise<…>; searchParams: Promise<…> }`.
- **Worktree.**
  - Use a fresh `.worktrees/sp8` off `main`, on branch `feature/sp8-abdm-nhcx`, and copy `.env.local` from the main checkout.
  - **Task 1 Step 0:** run `test -f src/lib/rcm/gateway.ts && test -f src/lib/rcm/snapshot.ts && test -f src/lib/queries/claim-submissions.ts && test -f src/lib/coding/code-systems.ts && test -f src/lib/blob-store.ts && test -f scripts/migrations/2026-10-07-sp7-c-preauth-claims.sql && grep -q "nhcxGatewayStub" src/lib/rcm/gateway.ts`.
  - If any check fails, stop and report. Never cherry-pick, and never touch other worktrees.
- **Spec §3, no fake data (ruling 1):**
  - The ABDM and NHCX mocks are reachable only when `mocksEnabled()` is true: `ABDM_USE_MOCKS === '1'` **and** neither `NODE_ENV` nor `VERCEL_ENV` is `'production'`.
  - Every row a mock produces carries `is_mock = true` or `source = 'abdm_sandbox_mock'`, and every UI that shows one shows the badge `Sandbox mock - not real`.
  - With no credentials and no mock, every capability reports `not_configured`, and every action route answers `503 { error: '<capability> is not configured' }` with the exact copy each task names.
- **Spec §3 Aadhaar / ABDM build-it-well (S1):** "Aadhaar numbers, one time passwords and passwords never reach a log or a database."
  - Aadhaar and OTP values exist only as a request-body field, then as RSA-OAEP ciphertext sent to ABDM.
  - They are never in a flow-store entry, an error message, an audit row, a `console.*` call, a URL or a response.
  - Each route reads the body, validates it, encrypts the value and drops the variable in one function (Task 5).
  - Static guards (Task 16) pin this.
- **Secrets (ruling 2):**
  - Credentials, private keys and certificates come only from environment variables, which `.env.example` lists by name with empty values.
  - PEM values are stored base64-encoded (one line) in env. Never commit a key or certificate.
  - Tests generate their key pairs at runtime with `generateKeyPairSync`.
  - No page, response, log line or audit row ever contains a secret, a token or a private key. The settings page shows only presence, the certificate subject, its SHA-256 fingerprint (first 16 hex characters) and its expiry.
- **Logs:** integration code logs only through `safeLog(tag, fields)` (Task 1), which keeps allowlisted keys (ids, codes, statuses, counts and durations) and drops everything else. No `console.*` call appears in `src/lib/abdm`, `src/lib/nhcx`, `src/lib/fhir/nhcx` or the SP8 routes (Task 16 enforces this).
- **Audit:**
  - Staff actions go through `logAudit(session, action, patientId, details, tx)`, with actions prefixed `abdm: ` / `nhcx: ` exactly as each task names them.
  - Gateway-originated writes go through `logGatewayEvent(source, action, patientId, details, executor)` (Task 1): `userName` is `'ABDM gateway'` or `'NHCX gateway'` and `role` is null. No `Session` is ever fabricated.
  - `details` carry only internal ids, enum values, exchange ids and the first 8 characters of correlation ids. Never ABHA numbers, ABHA addresses, mobile numbers, names, policy or member numbers, pre-auth references, UTRs, query text, dispositions, tokens or payloads.
- **IDs and time:** `serial` integer PKs; patient FKs are `text`. Protocol ids (`api_call_id`, `correlation_id`) are `crypto.randomUUID()` and are stored as `uuid`. Instants are UTC `timestamp`. Wire timestamps are ISO 8601 with offset, formatted as `new Date().toISOString()` for ABDM and in IST with offset (`+05:30`) for NHCX (Task 7).
- **Money:** FHIR `Money.value` is in rupees. Convert paise to rupees with `paiseToFhirMoney` and back with `fhirMoneyToPaise` (Task 9), which works through `parseRupeesToPaise(String(value))` and never multiplies floats. A response amount above `MAX_DOCUMENT_PAISE` or with more than 2 decimals counts as unparsable, and the summary field becomes `null`.
- **RBAC.** Constants go in `src/lib/role-policy.ts`, in a block commented `// SP8`:

  | Constant | Roles | Grants |
  |---|---|---|
  | `ABHA_LINK_ROLES` | admin, frontdesk, crc | create / verify / link ABHA, ABDM consent capture |
  | `ABDM_SHARE_QUEUE_ROLES` | admin, frontdesk | the Scan & Share registration queue |
  | `NHCX_ELIGIBILITY_ROLES` | admin, rcm, frontdesk, billing, crc | run and read NHCX eligibility checks (same as SP7 `POLICY_READ_ROLES`) |
  | `NHCX_EXCHANGE_ROLES` | admin, rcm | send a pre-auth via NHCX, view exchanges and responses, check status, confirm or dismiss a response |
  | `INTEGRATION_SETTINGS_ROLES` | admin | the ABDM / NHCX connection page and test-connection |

  - **API order:** `requireSession()`; then the inline allowlist, which returns exactly `NextResponse.json({ error: 'Forbidden' }, { status: 403 })`; then the rate limit where a task names one; then the body (`readJsonBody`); then the configuration check (503).
  - **Page order:** `requireSessionOrRedirect()`, then `redirect('/')` for a denied role.
  - **Harnesses:**
    - Every new staff route gets an `API_GATES` row.
    - Every new POST gets an `SP8_WRITE_GATES` deny-before-parse row in `tests/api/rbac-route-gates.test.ts`. Task 5 creates that array and adds it to the `describe.each` spread.
    - Every new page gets a `PAGE_GATES` row in `tests/pages/page-gates-harness.ts`.
    - No `gap` tags. `LeftNav` roles equal the page gate.
  - The two session-less routes (`/api/nhcx/callback/[...action]` and `/api/abdm/api/v3/hip/patient/share`) and the cron route have their own security tests (Tasks 6, 12 and 13) and are listed in a `SESSIONLESS_ROUTES` allowlist test (Task 16).
- **Schema:**
  - `src/db/schema.ts` gets a block commented `// SP8`, plus one idempotent migration, `scripts/migrations/2026-10-07-sp8-abdm-nhcx.sql`, in the SP7 style: `BEGIN; … COMMIT;`, `IF NOT EXISTS`, `DO` blocks for types, constraints and triggers, no `DROP`, no `UPDATE`.
  - Apply it **only** to the local container, **twice**: `/Users/k2a/.docker/bin/docker exec -i hims-local-pg psql -U postgres -d hims -v ON_ERROR_STOP=1 < scripts/migrations/2026-10-07-sp8-abdm-nhcx.sql`. Never `db:push`.
- **Tests:**
  - Pure and mocked tests: `npx vitest run <file>`. DB tests: `npm test -- <file>`.
  - DB fixtures are prefixed `TEST-SP8-${RUN}` and cleaned with `purgeSp8Fixtures` (Task 2), then SP7's `purgeRcmFixtures`.
  - **Never run the whole suite or `tests/db/seed.test.ts`.**
  - HTTP is always injected (`fetch` parameter / deps). No test touches the network.
- **Per-task verification:** the task's tests, plus `npx tsc --noEmit`, plus `npx eslint <changed files>`.
- **Branding:** no hard-coded product name (`brand` server-side, `useBrand()` client-side). FHIR `Organization.name` for the hospital comes from `brand.legalName`.
- **Merge hygiene:** additions go in `// SP8` blocks in `schema.ts`, `seed.ts`, `role-policy.ts`, `role-capabilities.ts`, `LeftNav.tsx`, both harness files and every SP7/SP1 file this plan edits. The executor commits per task; nothing is committed while planning.

## Review Focus

1. **An Aadhaar number or OTP escaping.** Watch for a thrown error that carries the request body, an ABDM 400 response echoed back to the browser, a `safeLog` call given the whole body, a flow-store entry, or a retry log line. The expected behaviour: the browser only ever sees fixed messages; Redis, Postgres and logs never hold the value.
   - Task 3 `encryptForAbdm never returns or throws the plaintext`, `ABDM error bodies are mapped to fixed messages`.
   - Task 5 `an Aadhaar OTP request leaves no trace in the flow store, the audit row or the response`, `a malformed Aadhaar is refused without echoing it`.
   - Task 16 static guards.
2. **A forged, replayed or late NHCX callback.** This covers: a callback with no JWT or a JWT signed by another key; a valid JWE replayed with the same `api_call_id`; a `correlation_id` we never issued; a recipient code that is not ours; a body over the size cap; a burst from one IP. Each must be refused before any database write, with a fixed body. A replay must return the original 202 without a second write.
   - Task 12 `rejects a callback whose JWT does not verify, before decrypting`, `a replayed api_call_id is acknowledged once and written once`, `an unknown correlation id is refused without a write`, `an oversized body is refused before parsing`.
3. **A claim sent twice, or sent and not recorded.** This covers: a double-clicked submit; a crash between insurer acceptance and our commit; a retry after a timeout whose first attempt actually reached NHCX. Every send is an outbox row created in the same transaction as the claim version. A retry reuses the same `api_call_id`, correlation id and JWE, and a version never gets a second outbox row.
   - Task 11 `the outbox row commits with the claim version and nothing is sent inside the transaction`, `a failed send is retried with the same api_call_id`, `concurrent submits create one exchange`.
4. **Sample or unmappable codes reaching an insurer.** This covers diagnoses from a `SAMPLE-` code set, HBP package codes without a verified system URI, a doctor with no registration number, and missing ROHINI/HFR identifiers. NHCX submission must be refused with a plain message naming the gap, and the manual channels must still work.
   - Task 10 `refuses a bundle with sample-set codes`, `refuses when the treating doctor has no registration number`.
   - Task 11 `NHCX refusal leaves the manual channel usable`.
5. **An insurer response quietly changing money.** This covers a ClaimResponse with an approved total, a PaymentNotice, or an inbound query. None may move claim status or the ledger by itself. Each is recorded, shown and pre-fills the SP7 form, and an RCM user confirms it.
   - Task 12 `a ClaimResponse records a note and a pending review but leaves status and money unchanged`.
   - Task 15 `confirming a response pre-fills the SP7 decision form`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/integrations/runtime.ts` | `isProductionRuntime`, `mocksEnabled` (pure over an env object) |
| `src/lib/integrations/config.ts` | `readAbdmConfig`, `readNhcxConfig`, capability status (server) |
| `src/lib/integrations/safe-log.ts` | Allowlisted structured logging (pure + `console.info` sink) |
| `src/lib/integrations/system-audit.ts` | `logGatewayEvent` (session-less audit writer) |
| `src/lib/integrations/certs.ts` | PEM/base64 decoding, `certificateSummary` (server) |
| `src/lib/integrations/payload-vault.ts` | AES-256-GCM at-rest encryption of inbound payloads with `INTEGRATION_PAYLOAD_KEY` (server) |
| `src/lib/abdm/constants.ts` | ABDM paths, scopes, login hints, consent code/version, error copy (pure) |
| `src/lib/abdm/encrypt.ts` | RSA/ECB/OAEPWithSHA-1AndMGF1Padding field encryption (server) |
| `src/lib/abdm/session.ts` | Gateway session token cache (shared with NHCX), standard headers (server) |
| `src/lib/abdm/gateway.ts` | `AbdmGateway` interface, result types, `AbdmError` (pure types) |
| `src/lib/abdm/http-adapter.ts` | Real ABHA V3 adapter (server) |
| `src/lib/abdm/mock-adapter.ts` | Env-flagged sandbox mock (server) |
| `src/lib/abdm/registry.ts` | `getAbdmGateway()` (server) |
| `src/lib/abdm/flow-store.ts` | Short-lived encrypted flow state in Redis (server) |
| `src/lib/abdm/consent.ts` | Consent text loading and hashing (server) |
| `src/lib/abdm/callback-auth.ts` | ABDM callback JWT verification (server) |
| `src/lib/nhcx/constants.ts` | NHCX paths, header names, statuses, entity types, error copy (pure) |
| `src/lib/nhcx/headers.ts` | Protocol-header build and validation (pure) |
| `src/lib/nhcx/jwe.ts` | JWE seal/open with `jose`, key rotation (server) |
| `src/lib/nhcx/client.ts` | Token, POST with retry and backoff, sync-response parsing (server) |
| `src/lib/nhcx/participants.ts` | Recipient encryption-cert lookup with a 24 h cache (server) |
| `src/lib/nhcx/claim-gateway.ts` | `NhcxClaimGateway`, `resolveNhcxClaimGateway` (server) |
| `src/lib/nhcx/mock-transport.ts` | Env-flagged mock transport that synthesises callbacks (server) |
| `src/lib/nhcx/inbound.ts` | Callback pipeline and per-action handlers (server) |
| `src/lib/nhcx/callback-auth.ts` | NHCX callback JWT + IP allowlist checks (server) |
| `src/lib/fhir/nhcx/systems.ts` | Profile URLs, CodeSystem URIs, identifier systems (pure) |
| `src/lib/fhir/nhcx/resources.ts` | Patient / Organization / Practitioner / Location / Coverage builders (pure) |
| `src/lib/fhir/nhcx/eligibility.ts` | CoverageEligibilityRequest bundle + response parser (pure) |
| `src/lib/fhir/nhcx/claim.ts` | Claim (preauthorization / claim) bundles (pure) |
| `src/lib/fhir/nhcx/responses.ts` | ClaimResponse, Communication/PaymentNotice TaskBundle parsers and builders (pure) |
| `src/lib/fhir/nhcx/validate.ts` | Structural validator for the S5 6.5.0 required elements (pure) |
| `src/lib/fhir/nhcx/money.ts` | `paiseToFhirMoney`, `fhirMoneyToPaise` (pure) |
| `src/lib/queries/abha-link.ts` | Apply a verified ABHA to a patient, consent rows |
| `src/lib/queries/abdm-profile-shares.ts` | Scan & Share rows, token numbers, queue |
| `src/lib/queries/nhcx-exchanges.ts` | Outbox, dispatch, status, review |
| `src/lib/queries/nhcx-eligibility.ts` | Eligibility checks |
| `src/app/api/abdm/abha/**`, `src/app/api/patients/[anonId]/abha/link/route.ts` | ABHA staff routes |
| `src/app/api/abdm/api/v3/hip/patient/share/route.ts` | Scan & Share callback (bridge URL = `<app>/api/abdm`) |
| `src/app/api/nhcx/**`, `src/app/api/rcm/preauths/[id]/nhcx/route.ts`, `src/app/api/cron/nhcx-sweep/route.ts`, `src/app/api/settings/integrations/test/route.ts` | NHCX and settings routes |
| `src/app/(dashboard)/settings/integrations/page.tsx`, `src/app/(dashboard)/front-desk/abdm-shares/page.tsx` | Pages |
| `src/components/abdm/*`, `src/components/nhcx/*`, `src/components/settings/IntegrationStatusCard.tsx` | Client components |
| `scripts/migrations/2026-10-07-sp8-abdm-nhcx.sql` | DDL |
| `tests/fixtures/nhcx/*.json` | NRCeS 6.5.0 example bundles, de-identified (Task 9) |
| `docs/ABDM-NHCX.md` | Onboarding, env, key generation and rotation, retention (operator runbook) |

---

### Task 1: Runtime flags, configuration, safe logging, gateway audit, certificates, payload vault, RBAC constants

**Files:**
- Create: `src/lib/integrations/{runtime,config,safe-log,system-audit,certs,payload-vault}.ts`, `docs/ABDM-NHCX.md`
- Modify:
  - `src/lib/crypto.ts`: add `encryptWithKey` / `decryptWithKey` and make `encryptSensitive` / `decryptSensitive` delegate to them, with behaviour unchanged.
  - `.env.example`: an `# SP8 ABDM / NHCX` block.
  - `src/lib/role-policy.ts` (`// SP8` block).
  - `src/lib/role-capabilities.ts`: append the bullets below.
- Test: `tests/lib/integrations/runtime-config.test.ts`, `tests/lib/integrations/safe-log.test.ts`, `tests/lib/integrations/certs-vault.test.ts`, `tests/lib/sp8-role-policy.test.ts`, `tests/lib/crypto.test.ts` (append)

**Interfaces:**
- Produces (`runtime.ts`, pure, parameter `env: Record<string, string | undefined> = process.env`):
  - `isProductionRuntime(env?): boolean`: `NODE_ENV === 'production' || VERCEL_ENV === 'production'`, the same rule as `src/db/seed.ts`.
  - `mocksEnabled(env?): boolean`: `ABDM_USE_MOCKS === '1' && !isProductionRuntime(env)`.
- Produces (`config.ts`):
  - `type CapabilityState = 'configured' | 'mock' | 'not_configured'`
  - `interface AbdmConfig { gatewayBaseUrl: string; abhaBaseUrl: string; clientId: string; clientSecret: string; cmId: string; hipId: string | null; gatewayJwksUrl: string | null; consentTextPath: string | null }`
  - `readAbdmConfig(env?): { state: 'configured'; config: AbdmConfig } | { state: 'mock' } | { state: 'not_configured'; missing: string[] }`
    - Required: `ABDM_GATEWAY_BASE_URL`, `ABHA_BASE_URL`, `ABDM_CLIENT_ID`, `ABDM_CLIENT_SECRET`, `ABDM_CM_ID`.
    - Optional: `ABDM_HIP_ID`, `ABDM_GATEWAY_JWKS_URL`, `ABDM_CONSENT_TEXT_PATH`.
    - Every URL must be `https:`, or the variable counts as missing.
    - `mock` is returned only when the required set is incomplete **and** `mocksEnabled(env)`. Real credentials always win over the mock.
  - `interface NhcxConfig { apiBaseUrl: string; participantServiceUrl: string; participantCode: string; encryptionPrivateKeyPem: string; previousEncryptionPrivateKeyPem: string | null; encryptionCertPem: string; gatewaySigningCertPem: string | null; callbackIpAllowlist: string[]; maxAttachmentBytes: number }`
  - `readNhcxConfig(env?)`: same union.
    - Required: `NHCX_API_BASE_URL`, `NHCX_PARTICIPANT_SERVICE_URL`, `NHCX_PARTICIPANT_CODE`, `NHCX_ENCRYPTION_PRIVATE_KEY` (base64 PEM), `NHCX_ENCRYPTION_CERT` (base64 PEM), and a configured ABDM state (NHCX authenticates with the ABDM gateway session, UNVERIFIED U3).
    - Optional: `NHCX_PREVIOUS_ENCRYPTION_PRIVATE_KEY`, `NHCX_GATEWAY_SIGNING_CERT`, `NHCX_CALLBACK_IP_ALLOWLIST` (comma-separated IPv4), `NHCX_MAX_ATTACHMENT_BYTES` (default `10_000_000`).
  - `interface CapabilityStatus { key: 'abha' | 'scan_share' | 'nhcx_submit' | 'nhcx_callbacks' | 'nhcx_eligibility'; state: CapabilityState; label: string; missing: string[] }`
  - `capabilityStatuses(env?): CapabilityStatus[]`:
    - `abha` follows ABDM.
    - `scan_share` needs ABDM configured plus `ABDM_HIP_ID` and `ABDM_GATEWAY_JWKS_URL`.
    - `nhcx_submit` and `nhcx_eligibility` follow NHCX.
    - `nhcx_callbacks` needs NHCX configured plus `NHCX_GATEWAY_SIGNING_CERT`.
    - Labels: `'Connected'`, `'Sandbox mock - not real'`, `'Not configured'`.
    - `missing` lists env variable **names only**, never values.
- Produces (`safe-log.ts`):
  - `SAFE_LOG_KEYS = ['exchangeId', 'claimId', 'preauthId', 'patientId', 'checkId', 'shareId', 'action', 'state', 'httpStatus', 'errorCode', 'attempt', 'durationMs', 'correlationPrefix', 'count', 'capability', 'outcome'] as const`
  - `safeLogFields(fields: Record<string, unknown>): Record<string, string | number | boolean>` keeps only `SAFE_LOG_KEYS`.
    - Values must be number, boolean, or a string matching `/^[A-Za-z0-9_.:\/-]{1,64}$/`. Any other value becomes `'[dropped]'`.
    - Every string then also goes through `redactAadhaarLike`.
  - `safeLog(tag: string, fields: Record<string, unknown>): void` calls `console.info(\`[${tag}]\`, JSON.stringify(safeLogFields(fields)))`.
- Produces (`system-audit.ts`): `logGatewayEvent(source: 'ABDM gateway' | 'NHCX gateway', action: string, patientId: string | null, details: string | null, executor?: AuditExecutor): Promise<void>`. It inserts into `auditLog` with `role: null`, and `action`/`details` go through `redactAadhaarLike`.
- Produces (`certs.ts`):
  - `decodePemEnv(value: string): string`: base64 to a PEM string. Throws `Error('Invalid PEM in environment')` (no value in the message) unless the result contains `-----BEGIN`.
  - `certificateSummary(pem: string, now?: Date): { subject: string; fingerprintPrefix: string; validTo: string; daysLeft: number; expired: boolean }`, built on `new X509Certificate(pem)`. `fingerprintPrefix` is the first 16 hex characters of `fingerprint256` with colons removed.
- Produces (`payload-vault.ts`): `sealPayload(json: string): string` and `openPayload(stored: string): string`, using `encryptWithKey` / `decryptWithKey` with `INTEGRATION_PAYLOAD_KEY` (32 bytes, base64). If the key is missing they throw `Error('INTEGRATION_PAYLOAD_KEY is not set')`.
- Produces (`crypto.ts`): `encryptWithKey(plaintext: string, key: Buffer): string`, `decryptWithKey(stored: string, key: Buffer): string`. The format is the existing `iv:tag:ciphertext`.
- Produces (role policy): the five constants from the Global Constraints table, each `readonly Role[]` in that order.
- Role capability bullets:
  - admin: `'Connect the hospital to ABDM and NHCX and test the connection'`
  - frontdesk and crc: `'Create or verify a patient\'s ABHA with the patient\'s consent'`
  - frontdesk only: `'Register patients who share their ABHA profile by scanning the desk QR code'`
  - rcm: `'Send pre-authorisations and claims through NHCX and review insurer responses'`
- `.env.example` block: names only, with comments giving the documented sandbox values as text:
  - `ABDM_GATEWAY_BASE_URL=` — comment `# sandbox https://dev.abdm.gov.in (S1 going-live.mdx); production https://apis.abdm.gov.in`.
  - `ABHA_BASE_URL=` — comment `# sandbox https://abhasbx.abdm.gov.in; production: from NHA at go-live (UNVERIFIED)`.
  - `ABDM_CM_ID=` — comment `# sandbox: sbx`.
  - `ABDM_CLIENT_ID=`, `ABDM_CLIENT_SECRET=`, `ABDM_HIP_ID=`, `ABDM_GATEWAY_JWKS_URL=`, `ABDM_CONSENT_TEXT_PATH=`, `ABDM_USE_MOCKS=`.
  - `NHCX_API_BASE_URL=` — comment `# sandbox https://apisbx.abdm.gov.in/hcx (S3, UNVERIFIED)`.
  - `NHCX_PARTICIPANT_SERVICE_URL=`, `NHCX_PARTICIPANT_CODE=`, `NHCX_ENCRYPTION_PRIVATE_KEY=`, `NHCX_PREVIOUS_ENCRYPTION_PRIVATE_KEY=`, `NHCX_ENCRYPTION_CERT=`, `NHCX_GATEWAY_SIGNING_CERT=`, `NHCX_CALLBACK_IP_ALLOWLIST=`, `NHCX_MAX_ATTACHMENT_BYTES=`.
  - `INTEGRATION_PAYLOAD_KEY=`, `CRON_SECRET=`.
- `docs/ABDM-NHCX.md` sections:
  - **What is real and what is mocked** (ruling 1).
  - **Onboarding**:
    - ABDM sandbox registration;
    - HFR ID for the facility;
    - bridge URL `PATCH /api/hiecm/gateway/v3/bridge/url` set to `<NEXT_PUBLIC_APP_URL>/api/abdm`;
    - the facility QR `https://phrsbx.abdm.gov.in/share-profile?hip-id=<HFR ID>&counter-id=<COUNTER>` (sandbox, S1; the production host is UNVERIFIED);
    - NHCX sandbox participant registration with role provider;
    - `endpoint_url` = `<NEXT_PUBLIC_APP_URL>/api/nhcx/callback`, which must be a domain hosted in India with no IP and no port (S3);
    - the sandbox-exit, WASA and functional-test route to production (S1 going-live.mdx).
  - **Every env variable**.
  - **Generating the NHCX key pair:**
    - command: `openssl req -x509 -newkey rsa:2048 -nodes -keyout nhcx.key -out nhcx.crt -days 365 -subj "/CN=<participant code>"`;
    - base64 each file to a single line, store it with `vercel env add`, then delete the local files;
    - self-signed certificates are accepted in the sandbox (S3, UNVERIFIED for production).
  - **Key rotation:**
    - generate a new pair;
    - upload the new certificate to NHCX (participant update or `/v2/update/cert`, S2);
    - move the old private key to `NHCX_PREVIOUS_ENCRYPTION_PRIVATE_KEY`, set the new one, redeploy;
    - keep the previous key for at least 48 hours (S3 says about a day), then clear it.
    - The settings page warns 30 days before expiry.
  - **Retention** (ruling 4).
  - **Cron:** `vercel.json` `crons` entry `{ "path": "/api/cron/nhcx-sweep", "schedule": "*/15 * * * *" }`, with `CRON_SECRET` set. The plan does not create `vercel.json`; the owner decides (ambiguity A3).
  - **Rollback:** unset the NHCX variables; the RCM falls back to the manual channels.

- [ ] **Step 0: Confirm SP4–SP7 are merged** (Global Constraints). Stop if not.
- [ ] **Step 1: Write the failing tests**

```ts
// runtime-config.test.ts
it('mocks are off in production even with the flag', () => {
  expect(mocksEnabled({ ABDM_USE_MOCKS: '1', NODE_ENV: 'production' })).toBe(false)
  expect(mocksEnabled({ ABDM_USE_MOCKS: '1', VERCEL_ENV: 'production', NODE_ENV: 'development' })).toBe(false)
  expect(mocksEnabled({ ABDM_USE_MOCKS: '1', NODE_ENV: 'development' })).toBe(true)
  expect(mocksEnabled({ NODE_ENV: 'development' })).toBe(false)
})
it('ABDM is not configured and lists only missing names', () => {
  const r = readAbdmConfig({ ABDM_CLIENT_ID: 'x', ABDM_CLIENT_SECRET: 'super-secret' })
  expect(r).toEqual({ state: 'not_configured', missing: ['ABDM_GATEWAY_BASE_URL', 'ABHA_BASE_URL', 'ABDM_CM_ID'] })
  expect(JSON.stringify(r)).not.toContain('super-secret')
})
it('an http base URL counts as missing', () => { expect(readAbdmConfig({ ...FULL_ABDM, ABHA_BASE_URL: 'http://abhasbx.abdm.gov.in' })).toMatchObject({ state: 'not_configured', missing: ['ABHA_BASE_URL'] }) })
it('real credentials win over the mock flag', () => { expect(readAbdmConfig({ ...FULL_ABDM, ABDM_USE_MOCKS: '1', NODE_ENV: 'development' }).state).toBe('configured') })
it('NHCX needs ABDM and its own keys', () => {
  expect(readNhcxConfig({ ...FULL_NHCX, ABDM_CLIENT_ID: undefined }).state).toBe('not_configured')
  expect(readNhcxConfig(FULL_NHCX)).toMatchObject({ state: 'configured', config: { participantCode: '1000099@sbx', maxAttachmentBytes: 10_000_000 } })
})
it('capability statuses', () => {
  const s = capabilityStatuses({ ...FULL_ABDM })
  expect(s.find((c) => c.key === 'abha')!.state).toBe('configured'); expect(s.find((c) => c.key === 'scan_share')!.missing).toEqual(['ABDM_HIP_ID', 'ABDM_GATEWAY_JWKS_URL'])
  expect(s.find((c) => c.key === 'nhcx_submit')!.label).toBe('Not configured')
})
// safe-log.test.ts
it('keeps only allowlisted, plain values and redacts Aadhaar-like strings', () => {
  expect(safeLogFields({ exchangeId: 7, otp: '123456', aadhaar: '234123412346', errorCode: 'NHCX-1004', patientId: 'RD-1 x' }))
    .toEqual({ exchangeId: 7, errorCode: 'NHCX-1004', patientId: '[dropped]' })
  expect(safeLogFields({ errorCode: '234123412346' }).errorCode).not.toContain('234123412346')
})
// certs-vault.test.ts (runtime-generated self-signed cert via a helper that shells nothing: use node:crypto + a minimal X.509 from tests/helpers/selfsigned.ts)
it('summarises a certificate without exposing key material', () => {
  const s = certificateSummary(TEST_CERT_PEM, new Date('2026-10-08T00:00:00Z'))
  expect(s.fingerprintPrefix).toMatch(/^[0-9A-F]{16}$/); expect(typeof s.daysLeft).toBe('number'); expect(JSON.stringify(s)).not.toMatch(/BEGIN/)
})
it('decodePemEnv refuses junk without echoing it', () => { expect(() => decodePemEnv(Buffer.from('hello').toString('base64'))).toThrow('Invalid PEM in environment') })
it('the vault round-trips and tampering fails', () => {
  process.env.INTEGRATION_PAYLOAD_KEY = randomBytes(32).toString('base64')
  const s = sealPayload('{"a":1}'); expect(openPayload(s)).toBe('{"a":1}'); expect(() => openPayload(s.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toThrow()
})
// crypto.test.ts (append)
it('encryptSensitive still round-trips through encryptWithKey', () => { /* existing vectors unchanged */ })
// sp8-role-policy.test.ts
it('SP8 allowlists are exact', () => {
  expect(ABHA_LINK_ROLES).toEqual(['admin', 'frontdesk', 'crc']); expect(ABDM_SHARE_QUEUE_ROLES).toEqual(['admin', 'frontdesk'])
  expect(NHCX_ELIGIBILITY_ROLES).toEqual(['admin', 'rcm', 'frontdesk', 'billing', 'crc']); expect(NHCX_EXCHANGE_ROLES).toEqual(['admin', 'rcm']); expect(INTEGRATION_SETTINGS_ROLES).toEqual(['admin'])
})
```

Self-signed certificates in tests: `tests/helpers/selfsigned.ts` exports `makeTestKeyPairAndCert(cn: string, days: number): { privateKeyPem: string; certPem: string }`. It generates the RSA key with `generateKeyPairSync('rsa', { modulusLength: 2048 })` and calls `openssl` through `execFileSync` only when it is on PATH, otherwise `it.skip`s the certificate cases. Check first with `which openssl`; macOS ships LibreSSL `openssl`, which is fine.

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/integrations tests/lib/sp8-role-policy.test.ts tests/lib/crypto.test.ts` → FAIL.
- [ ] **Step 3: Implement** the modules, the `crypto.ts` refactor, the role constants, the capability bullets, the `.env.example` block and the runbook.
- [ ] **Step 4: Verify:** same command, plus `npx vitest run tests/lib/role-capabilities.test.ts tests/lib/role-policy.test.ts`, plus `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/integrations src/lib/crypto.ts src/lib/role-policy.ts src/lib/role-capabilities.ts .env.example docs/ABDM-NHCX.md tests/lib/integrations tests/lib/sp8-role-policy.test.ts tests/lib/crypto.test.ts tests/helpers/selfsigned.ts
git commit -m "feat(sp8): integration runtime flags, config status, safe logging, gateway audit, cert summary and payload vault"
```

---

### Task 2: Schema — ABHA verification, consents, profile shares, NHCX exchanges, inbound calls, eligibility checks

**Files:**
- Modify:
  - `src/db/schema.ts` (`// SP8` block).
  - `src/db/seed.ts` (`clearExistingData`): delete `nhcxInboundCalls`, `nhcxExchanges`, `nhcxEligibilityChecks`, `abdmProfileShares` and `abdmConsents` before the SP7 tables and `patients`, inside the purge-enabled transaction.
  - `src/lib/queries/patients.ts` `deletePatient`: delete the patient's `abdm_consents`, `abdm_profile_shares` (where linked) and `nhcx_eligibility_checks` before the patient. A patient with any `nhcx_exchanges` row is already blocked by SP7's financial-records guard, because exchanges exist only for policies, pre-auths and claims; add an explicit check that throws `PatientHasFinancialRecordsError`.
- Create: `scripts/migrations/2026-10-07-sp8-abdm-nhcx.sql`, `tests/db/sp8-fixtures.ts`
- Test: `tests/db/sp8-schema.test.ts`

**Interfaces:**
- Produces (pure constants in `src/lib/nhcx/constants.ts` and `src/lib/abdm/constants.ts`, created here with just these exports; later tasks extend the files):
  - `ABHA_VERIFICATION_SOURCES = ['abdm', 'abdm_sandbox_mock']`
  - `ABHA_VERIFIED_VIA = ['aadhaar_otp_enrolment', 'abha_number_aadhaar_otp', 'abha_number_mobile_otp', 'mobile_otp', 'aadhaar_otp_login', 'abha_address_otp', 'scan_and_share']`
  - `ABDM_CONSENT_PURPOSES = ['abha_enrolment', 'abha_verification']`
  - `PROFILE_SHARE_STATUSES = ['pending', 'registered', 'linked', 'dismissed', 'expired']`
  - `NHCX_ENTITY_TYPES = ['coverageeligibility', 'preauth', 'claim', 'communication', 'paymentnotice', 'status']`
  - `NHCX_EXCHANGE_STATES = ['pending_send', 'sent', 'send_failed', 'queued', 'dispatched', 'responded', 'error', 'no_response', 'received', 'acknowledged']`
  - `NHCX_REVIEW_STATES = ['not_needed', 'pending', 'confirmed', 'dismissed']`
  - `ELIGIBILITY_PURPOSES = ['validation', 'benefits', 'auth-requirements', 'discovery']`
  - `ELIGIBILITY_CONTEXTS = ['registration', 'admission', 'preauth', 'manual']`
  - `ELIGIBILITY_STATUSES = ['pending', 'eligible', 'not_eligible', 'error', 'no_response']`
  - `INBOUND_CALL_OUTCOMES = ['accepted', 'rejected']`
- Produces (schema, exact):
  - **`patients`** gains:
    - `abhaVerifiedAt: timestamp('abha_verified_at')`
    - `abhaVerificationSource: text('abha_verification_source', { enum: ABHA_VERIFICATION_SOURCES })`
    - `abhaVerifiedVia: text('abha_verified_via', { enum: ABHA_VERIFIED_VIA })`
    - Check `patients_abha_verification_complete`: `(abha_verified_at IS NULL) = (abha_verification_source IS NULL) AND (abha_verified_at IS NULL) = (abha_verified_via IS NULL)`.
  - **`abdmConsents`** (`abdm_consents`):
    - Columns: `id`, `patientId → patients` (nullable: consent may be given before registration), `flowId text not null`, `purpose text enum not null`, `consentCode text not null`, `consentVersion text not null`, `textSha256 text not null`, `givenBy text {enum ['patient','guardian']} not null`, `recordedByName not null`, `recordedByUserId → users`, `recordedAt defaultNow not null`.
    - `index('abdm_consents_patient_idx')`, `index('abdm_consents_flow_idx')`.
    - Append-only trigger `abdm_consents_append_only`. Its only exception is an update that sets `patient_id` from NULL; the trigger function checks columns.
  - **`abdmProfileShares`** (`abdm_profile_shares`):
    - Columns: `id`, `requestId text not null` (`unique('abdm_profile_shares_request_unique')`), `hipId not null`, `counterId not null`, `intent text not null`, `abhaNumber text`, `abhaAddress text`, `name text`, `gender text`, `yearOfBirth int`, `monthOfBirth int`, `dayOfBirth int`, `phone text`, `addressLine text`, `districtName text`, `stateName text`, `pincode text`, `tokenDate date not null`, `tokenNumber int not null`, `status default 'pending' not null`, `patientId → patients`, `ackState text {enum ['pending','sent','failed']} default 'pending' not null`, `isMock boolean default false not null`, `receivedAt defaultNow not null`, `resolvedAt`, `resolvedByName`.
    - `uniqueIndex('abdm_profile_shares_token_unique').on(tokenDate, counterId, tokenNumber)`.
    - Check `abdm_profile_shares_expired_scrubbed`: `status <> 'expired' OR (abha_number IS NULL AND abha_address IS NULL AND name IS NULL AND phone IS NULL AND address_line IS NULL)`.
  - **`nhcxExchanges`** (`nhcx_exchanges`):
    - Identity: `id`, `entityType text enum not null`, `direction text {enum ['outbound','inbound']} not null`, `action text not null` (e.g. `claim/submit`), `correlationId uuid not null`, `apiCallId uuid not null` (`unique('nhcx_exchanges_api_call_unique')`), `senderCode text not null`, `recipientCode text not null`.
    - State: `state text enum not null`, `protocolStatus text`.
    - Links: `patientId text not null → patients`, `policyId → patient_policies`, `preauthId → preauths`, `preauthEventId → preauth_events`, `claimId → claims`, `claimSubmissionId → claim_submissions`, `eligibilityCheckId → nhcx_eligibility_checks`, `rcmQueryId → rcm_queries`, `relatedExchangeId integer` (self, no FK).
    - Delivery: `attempts int default 0 not null`, `nextAttemptAt timestamp`, `lastErrorCode text`, `lastPolledAt timestamp`.
    - Payload: `bodySha256 text not null`, `jweEncrypted text` (outbound only; the sealed JWE kept through the vault so a retry resends identical bytes; nulled when the state leaves `pending_send`/`send_failed`), `payloadEncrypted text` (inbound only, vault-sealed decrypted FHIR JSON), `summary jsonb $type<NhcxResponseSummary>`.
    - Review: `reviewState text enum default 'not_needed' not null`, `reviewedByName`, `reviewedAt`.
    - Flags and times: `isMock boolean default false not null`, `createdAt`, `updatedAt`, `respondedAt`.
    - Indexes: `nhcx_exchanges_correlation_idx`, `nhcx_exchanges_claim_idx`, `nhcx_exchanges_preauth_idx`, `nhcx_exchanges_due_idx` on (`state`, `nextAttemptAt`).
    - Checks:
      - `nhcx_exchanges_payload_direction`: `(direction = 'inbound' OR payload_encrypted IS NULL) AND (direction = 'outbound' OR jwe_encrypted IS NULL)`;
      - `nhcx_exchanges_one_claim_submission`: a partial unique index `uniqueIndex('nhcx_exchanges_submission_unique').on(claimSubmissionId).where(sql\`direction = 'outbound' AND claim_submission_id IS NOT NULL\`)`;
      - `nhcx_exchanges_attempts_range`: 0..10.
  - `type NhcxResponseSummary = { outcome: 'queued' | 'complete' | 'partial' | 'error' | null; use: 'claim' | 'preauthorization' | null; submittedPaise: number | null; benefitPaise: number | null; preAuthRefPresent: boolean; inforce: boolean | null; errorCodes: string[]; adjudicationReasonCodes: string[]; paymentAmountPaise: number | null; paymentDate: string | null; hasQueryText: boolean }`. It holds no free text and no references; the text stays in `payloadEncrypted`.
  - **`nhcxInboundCalls`** (`nhcx_inbound_calls`): `apiCallId uuid PK`, `action text not null`, `senderCode text not null`, `correlationId uuid not null`, `outcome text enum not null`, `exchangeId integer`, `receivedAt defaultNow not null`. Append-only trigger `nhcx_inbound_calls_append_only`, bypassed only under `hims.allow_document_purge = 'on'` (the 30-day purge, Task 13).
  - **`nhcxEligibilityChecks`** (`nhcx_eligibility_checks`): `id`, `patientId not null`, `policyId not null → patient_policies`, `payerId not null → payers`, `purpose text enum not null`, `context text enum not null`, `status text enum default 'pending' not null`, `inforce boolean`, `requestedByName not null`, `requestedByUserId`, `requestedAt defaultNow not null`, `respondedAt`, `isMock boolean default false not null`; `index('nhcx_eligibility_patient_idx')`.
  - Types: `AbdmConsentRow`, `AbdmProfileShareRow`, `NhcxExchangeRow`, `NhcxInboundCallRow`, `NhcxEligibilityCheckRow`.
- Produces (`tests/db/sp8-fixtures.ts`): `purgeSp8Fixtures(patientIds: string[]): Promise<void>`. It runs one transaction with `set_config('hims.allow_document_purge', 'on', true)` and deletes in this order: `nhcx_inbound_calls` (of those exchanges), `nhcx_exchanges`, `nhcx_eligibility_checks`, `abdm_profile_shares`, `abdm_consents`.

- [ ] **Step 1: Write the failing tests**

```ts
const M = '2026-10-07-sp8-abdm-nhcx.sql'
it('migration is idempotent and declares every column', () => {
  const s = readMigration(M); expect(idempotencyProblems(s)).toEqual([])
  for (const t of [abdmConsents, abdmProfileShares, nhcxExchanges, nhcxInboundCalls, nhcxEligibilityChecks]) expect(missingColumns(t, s)).toEqual([])
  for (const c of ['abha_verified_at', 'abha_verification_source', 'abha_verified_via', 'patients_abha_verification_complete', 'nhcx_exchanges_submission_unique', 'nhcx_exchanges_payload_direction', 'abdm_profile_shares_expired_scrubbed', 'nhcx_inbound_calls_append_only', 'abdm_consents_append_only']) expect(s).toContain(c)
  expect(s).not.toMatch(/\bUPDATE\s+patients\b/i); expect(s).not.toMatch(/aadhaar/i)
})
describe.skipIf(!process.env.DATABASE_URL)('SP8 schema (DB)', () => {
  it('one outbound exchange per claim submission', async () => { /* second insert with same claim_submission_id → isUniqueViolation(e, 'nhcx_exchanges_submission_unique') */ })
  it('a replayed api_call_id is a unique violation', async () => {})
  it('an expired share must be scrubbed', async () => { /* status expired with name set → check violation */ })
  it('inbound calls and consents are append-only', async () => { /* update → 55000; consent patient_id NULL→id allowed once */ })
  it('ABHA verification columns are all-or-nothing', async () => {})
})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/db/sp8-schema.test.ts` → FAIL.
- [ ] **Step 3: Implement** the schema, the migration, the seed and `deletePatient` edits, and the fixtures helper.
- [ ] **Step 4: Apply twice, then verify:** run the docker command twice (both runs end in `COMMIT`). Then `npm test -- tests/db/sp8-schema.test.ts tests/lib/queries/delete-patient-fk-guard.test.ts tests/db/seed-clear-existing-data-fk-order.test.ts`, plus `npx vitest run tests/db/schema.test.ts tests/lib/no-aadhaar-leak.test.ts`, plus `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/seed.ts src/lib/queries/patients.ts src/lib/abdm/constants.ts src/lib/nhcx/constants.ts scripts/migrations/2026-10-07-sp8-abdm-nhcx.sql tests/db/sp8-schema.test.ts tests/db/sp8-fixtures.ts
git commit -m "feat(sp8): ABHA verification, consent, profile-share, NHCX exchange and eligibility schema"
```

---

### Task 3: ABDM field encryption, gateway session and standard headers

**Files:**
- Create: `src/lib/abdm/encrypt.ts`, `src/lib/abdm/session.ts`
- Modify: `src/lib/abdm/constants.ts`
- Test: `tests/lib/abdm/encrypt.test.ts`, `tests/lib/abdm/session.test.ts`

**Interfaces:**
- Produces (`constants.ts`, S1, `hiecm-gateway.yaml` / `hiecm-m1.yaml`):
  - `ABDM_PATHS` (as const):
    - `{ session: '/api/hiecm/gateway/v3/sessions', publicCert: '/abha/api/v3/profile/public/certificate',`
    - `enrolRequestOtp: '/abha/api/v3/enrollment/request/otp', enrolByAadhaar: '/abha/api/v3/enrollment/enrol/byAadhaar',`
    - `enrolAuthByAbdm: '/abha/api/v3/enrollment/auth/byAbdm', enrolSuggestion: '/abha/api/v3/enrollment/enrol/suggestion',`
    - `enrolAbhaAddress: '/abha/api/v3/enrollment/enrol/abha-address', loginRequestOtp: '/abha/api/v3/profile/login/request/otp',`
    - `loginVerify: '/abha/api/v3/profile/login/verify', loginVerifyUser: '/abha/api/v3/profile/login/verify/user',`
    - `profileAccount: '/abha/api/v3/profile/account', phrSearch: '/abha/api/v3/phr/web/login/abha/search',`
    - `phrRequestOtp: '/abha/api/v3/phr/web/login/abha/request/otp', phrVerify: '/abha/api/v3/phr/web/login/abha/verify',`
    - `phrProfile: '/abha/api/v3/phr/web/login/profile/abha-profile', onShare: '/api/hiecm/patient-share/v3/on-share' }`
    - The spelling is `byAadhaar`, with a double "a" (S1). The value in `src/lib/abdm/constants.ts` is allowed to contain "aadhaar" (Task 16 allowlist).
  - `ABHA_ENCRYPTION_ALGORITHM = 'RSA/ECB/OAEPWithSHA-1AndMGF1Padding'`
  - `ENROL_CONSENT = { code: 'abha-enrollment', version: '1.4' }` (S1).
  - `LOGIN_ROUTES`, each `{ scope: string[]; loginHint: string; otpSystem: 'aadhaar' | 'abdm' }`:
    - `abha_number_aadhaar_otp: { scope: ['abha-login','aadhaar-verify'], loginHint: 'abha-number', otpSystem: 'aadhaar' }`
    - `abha_number_mobile_otp: { scope: ['abha-login','mobile-verify'], loginHint: 'abha-number', otpSystem: 'abdm' }`
    - `mobile_otp: { scope: ['abha-login','mobile-verify'], loginHint: 'mobile', otpSystem: 'abdm' }`
    - `aadhaar_otp_login: { scope: ['abha-login','aadhaar-verify'], loginHint: 'aadhaar', otpSystem: 'aadhaar' }`
    - `abha_address_otp: { scope: ['abha-address-login','mobile-verify'], loginHint: 'abha-address', otpSystem: 'abdm' }` (PHR path)
  - `ABDM_ERROR_COPY` (as const):
    - `{ not_configured: 'ABDM is not configured', otp_invalid: 'The OTP is incorrect or has expired', rate_limited: 'Too many attempts; wait a minute and try again',`
    - `abdm_unavailable: 'ABDM did not respond; try again shortly', invalid_input: 'Check the number and try again', flow_expired: 'This verification has expired; start again',`
    - `consent_missing: 'Record the patient\'s consent first', consent_text_missing: 'ABHA creation is not available until the NHA consent text is installed (see docs/ABDM-NHCX.md)',`
    - `abha_conflict: 'This ABHA is already linked to another patient', account_choice_required: 'Choose which ABHA to link' }`
- Produces (`encrypt.ts`):
  - `encryptForAbdm(plaintext: string, publicKeySpkiBase64: string): string`. It uses `publicEncrypt({ key: createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' }), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(plaintext, 'utf8')).toString('base64')`.
  - SHA-1 for both the OAEP digest and MGF1 (S1 `concepts/encryption.mdx`; Node uses `oaepHash` for both).
  - Any failure throws `AbdmEncryptionError` with the fixed message `'Could not encrypt for ABDM'`, so the plaintext never reaches a `cause`.
- Produces (`session.ts`, server):
  - `abdmHeaders(extra?: Record<string, string>, now?: Date): Record<string, string>` → `{ 'REQUEST-ID': randomUUID(), TIMESTAMP: now.toISOString(), 'Content-Type': 'application/json', ...extra }`.
  - `interface SessionDeps { fetch: typeof fetch; now: () => Date }`.
  - `getGatewayToken(cfg: AbdmConfig, deps?: SessionDeps): Promise<string>`:
    - POSTs `{ clientId, clientSecret, grantType: 'client_credentials' }` to `${cfg.gatewayBaseUrl}${ABDM_PATHS.session}` with headers plus `X-CM-ID: cfg.cmId`.
    - Accepts 200 or 202 with `{ accessToken, expiresIn }`.
    - Caches it in module memory until `expiresIn − 60` seconds, with single-flight (concurrent callers share one promise).
    - On non-2xx it throws `AbdmHttpError(status)`, with no body in the message.
  - `resetGatewayTokenCache(): void` (tests).
  - `getAbhaPublicKey(cfg, deps?): Promise<string>`: GETs `${cfg.abhaBaseUrl}${ABDM_PATHS.publicCert}` with `abdmHeaders()` plus `Authorization: Bearer <token>`, returns `publicKey`, and caches it for 6 hours.
    - When the response's `encryptionAlgorithm` differs from `ABHA_ENCRYPTION_ALGORITHM`, it throws `AbdmHttpError(502)` and logs `safeLog('abdm', { errorCode: 'unexpected_algorithm' })`.
  - `mapAbdmFailure(status: number): keyof typeof ABDM_ERROR_COPY`: 400/422 → `invalid_input`, 401 → `otp_invalid` for OTP verify calls (the caller passes `{ otpStep: true }`) and `abdm_unavailable` otherwise, 429 → `rate_limited`, everything else → `abdm_unavailable`. ABDM response bodies are never read into messages.

- [ ] **Step 1: Write the failing tests**

```ts
// encrypt.test.ts
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096 })
const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
it('encrypts with OAEP SHA-1 so ABDM can decrypt', () => {
  const ct = encryptForAbdm('123456', spki)
  expect(privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(ct, 'base64')).toString()).toBe('123456')
  expect(() => privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(ct, 'base64'))).toThrow()
})
it('encryptForAbdm never returns or throws the plaintext', () => {
  const secret = '234123412346'
  let msg = ''; try { encryptForAbdm(secret, 'not-a-key') } catch (e) { msg = String(e) + JSON.stringify(e) + String((e as Error).cause ?? '') }
  expect(msg).toContain('Could not encrypt for ABDM'); expect(msg).not.toContain(secret)
  expect(encryptForAbdm(secret, spki)).not.toContain(secret)
})
// session.test.ts
it('fetches one token for concurrent callers and refreshes 60 s before expiry', async () => {
  const fetch = vi.fn().mockResolvedValue(json(202, { accessToken: 'T1', expiresIn: 1200 }))
  let t = new Date('2026-10-08T00:00:00Z'); const deps = { fetch, now: () => t }
  expect(await Promise.all([getGatewayToken(CFG, deps), getGatewayToken(CFG, deps)])).toEqual(['T1', 'T1']); expect(fetch).toHaveBeenCalledTimes(1)
  const [, init] = fetch.mock.calls[0]; expect(init.headers['X-CM-ID']).toBe('sbx'); expect(JSON.parse(init.body)).toEqual({ clientId: 'cid', clientSecret: 'csec', grantType: 'client_credentials' })
  t = new Date(t.getTime() + 1141_000); fetch.mockResolvedValue(json(202, { accessToken: 'T2', expiresIn: 1200 })); expect(await getGatewayToken(CFG, deps)).toBe('T2')
})
it('ABDM error bodies are mapped to fixed messages', async () => {
  const fetch = vi.fn().mockResolvedValue(json(401, { error: 'clientSecret csec is wrong' }))
  await expect(getGatewayToken(CFG, { fetch, now: () => new Date() })).rejects.toThrow(/^ABDM HTTP 401$/)
  expect(mapAbdmFailure(401, { otpStep: true })).toBe('otp_invalid'); expect(mapAbdmFailure(500)).toBe('abdm_unavailable')
})
it('refuses an unexpected encryption algorithm', async () => { /* publicCert returns encryptionAlgorithm 'RSA/ECB/PKCS1Padding' → rejects */ })
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/abdm/encrypt.test.ts tests/lib/abdm/session.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same command, plus `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/abdm tests/lib/abdm
git commit -m "feat(sp8): ABDM RSA-OAEP-SHA1 field encryption, cached gateway session and public key"
```

---

### Task 4: `AbdmGateway` interface, real ABHA V3 adapter, sandbox mock, registry

**Files:**
- Create: `src/lib/abdm/gateway.ts`, `src/lib/abdm/http-adapter.ts`, `src/lib/abdm/mock-adapter.ts`, `src/lib/abdm/registry.ts`
- Test: `tests/lib/abdm/http-adapter.test.ts`, `tests/lib/abdm/mock-adapter.test.ts`, `tests/lib/abdm/registry.test.ts`

**Interfaces:**
- Consumes: Task 1 `readAbdmConfig`, `mocksEnabled`, `safeLog`; Task 3.
- Produces (`gateway.ts`):

```ts
export type AbdmFailure = keyof typeof ABDM_ERROR_COPY
export type AbdmResult<T> = { ok: true; value: T } | { ok: false; error: AbdmFailure }
export interface AbhaProfileView { abhaNumber: string /* 14 digits, normalised */; abhaAddresses: string[]; preferredAbhaAddress: string | null; name: string; gender: 'M' | 'F' | 'O' | null; yearOfBirth: number | null; mobileMasked: string | null; abhaStatus: string | null }
export type LoginRoute = keyof typeof LOGIN_ROUTES
export interface AbdmGateway {
  readonly source: 'abdm' | 'abdm_sandbox_mock'
  status(): { state: CapabilityState; label: string }
  testConnection(): Promise<AbdmResult<{ tokenExpiresInSeconds: number }>>
  enrolRequestAadhaarOtp(input: { encryptedAadhaar: string }): Promise<AbdmResult<{ txnId: string }>>
  enrolByAadhaarOtp(input: { txnId: string; encryptedOtp: string; mobile: string }): Promise<AbdmResult<{ txnId: string; userToken: string; profile: AbhaProfileView; isNew: boolean }>>
  enrolAddressSuggestions(input: { txnId: string }): Promise<AbdmResult<{ suggestions: string[] }>>
  enrolSetAddress(input: { txnId: string; abhaAddress: string }): Promise<AbdmResult<{ preferredAbhaAddress: string }>>
  loginRequestOtp(input: { route: LoginRoute; encryptedLoginId: string }): Promise<AbdmResult<{ txnId: string }>>
  loginVerifyOtp(input: { route: LoginRoute; txnId: string; encryptedOtp: string }): Promise<AbdmResult<{ userToken: string | null; transientToken: string | null; accounts: { abhaNumber: string; name: string | null }[] }>>
  loginSelectAccount(input: { transientToken: string; txnId: string; abhaNumber: string }): Promise<AbdmResult<{ userToken: string }>>
  fetchProfile(input: { userToken: string; route: LoginRoute | 'enrolment' }): Promise<AbdmResult<AbhaProfileView>>
  encrypt(plaintext: string): Promise<AbdmResult<string>>
}
```

- **`httpAbdmGateway(cfg: AbdmConfig, deps?: SessionDeps): AbdmGateway`**, exact wire shapes from S1:
  - **`enrolRequestAadhaarOtp`** → `enrolRequestOtp` with body `{ txnId: '', scope: ['abha-enrol'], loginHint: 'aadhaar', loginId: encryptedAadhaar, otpSystem: 'aadhaar' }`.
  - **`enrolByAadhaarOtp`** → `enrolByAadhaar` with body `{ authData: { authMethods: ['otp'], otp: { txnId, otpValue: encryptedOtp, mobile } }, consent: ENROL_CONSENT }`.
    - `userToken = tokens.token`; `profile` from `ABHAProfile`: `ABHANumber` normalised, `phrAddress[]`, `firstName/middleName/lastName` joined, `gender`, `yearOfBirth` from `yearOfBirth` or `dob`, and `mobile` masked to `******` + the last 4.
  - **`enrolAddressSuggestions`** → GET `enrolSuggestion`, header `TRANSACTION_ID: txnId`, reads `abhaAddressList`.
  - **`enrolSetAddress`** → POST `enrolAbhaAddress` with `{ txnId, abhaAddress, preferred: 1 }`, reads `preferredAbhaAddress`.
  - **`loginRequestOtp`**: for `abha_address_otp`, `phrRequestOtp`; otherwise `loginRequestOtp`. Body `{ scope, loginHint, loginId: encryptedLoginId, otpSystem }` from `LOGIN_ROUTES[route]`.
    - The caller encrypts the login id. An ABHA number is encrypted in its dashed `NN-NNNN-NNNN-NNNN` form (S1: bare digits are rejected), a mobile as 10 digits, an ABHA address as typed.
  - **`loginVerifyOtp`** → `loginVerify` (or `phrVerify`) with body `{ scope, authData: { authMethods: ['otp'], otp: { txnId, otpValue: encryptedOtp } } }`.
    - For `mobile_otp` the returned token is a 300-second T-token: return `transientToken`, `userToken: null` and `accounts`.
    - For the Aadhaar and ABHA-number routes, `userToken = token` (S1 [observed, annex]: Aadhaar OTP login returns the final token).
  - **`loginSelectAccount`** → `loginVerifyUser`, header `T-token: Bearer <transientToken>`, body `{ ABHANumber: formatAbhaNumber(abhaNumber), txnId }`.
  - **`fetchProfile`** → `profileAccount` (or `phrProfile` for the address route), header `X-token: Bearer <userToken>`. The `Bearer ` prefix is required (S1).
  - **`encrypt`** → `encryptForAbdm(plain, await getAbhaPublicKey(cfg))`.
  - **Every call:** `abdmHeaders()` plus `Authorization: Bearer <gateway token>`, a 15-second `AbortSignal.timeout`, and no retry (OTP calls are not idempotent). Non-2xx goes to `mapAbdmFailure`. Each call logs `safeLog('abdm', { action, httpStatus, durationMs })`.
- **`mockAbdmGateway(): AbdmGateway`**:
  - `source: 'abdm_sandbox_mock'`; `status()` → `{ state: 'mock', label: 'Sandbox mock - not real' }`.
  - Deterministic: every OTP `'123456'` is accepted and anything else → `otp_invalid`. The mock "decrypts" by keeping the plaintext only inside the encrypt/verify pair: `encrypt` returns `mock:` + sha256 hex.
  - ABHA numbers are fabricated as `91` + 12 digits derived from the sha256, so they can never collide with a real Aadhaar (it is a 14-digit value).
  - Addresses are `<name-ish>@sbx`.
  - It lives in its own module and is imported **only** by `registry.ts` (Task 16 guard).
- **`getAbdmGateway(env?): AbdmGateway | null`**: `readAbdmConfig` configured → http adapter; `mock` → mock adapter; else `null` (routes map `null` to 503 `ABDM is not configured`).

- [ ] **Step 1: Write the failing tests**

```ts
// http-adapter.test.ts (fetch fake records url, headers, body)
it('requests an Aadhaar enrolment OTP with the documented body', async () => {
  const { gw, calls } = adapter({ [ABDM_PATHS.enrolRequestOtp]: json(200, { txnId: 't1', message: 'sent' }) })
  expect(await gw.enrolRequestAadhaarOtp({ encryptedAadhaar: 'ENC' })).toEqual({ ok: true, value: { txnId: 't1' } })
  expect(calls.at(-1)!.url).toBe('https://abhasbx.example' + ABDM_PATHS.enrolRequestOtp)
  expect(calls.at(-1)!.body).toEqual({ txnId: '', scope: ['abha-enrol'], loginHint: 'aadhaar', loginId: 'ENC', otpSystem: 'aadhaar' })
  expect(calls.at(-1)!.headers).toMatchObject({ Authorization: 'Bearer GW', 'REQUEST-ID': expect.stringMatching(UUID), TIMESTAMP: expect.any(String) })
})
it('enrols with consent abha-enrollment 1.4 and maps the profile', async () => { /* ABHAProfile fixture from S1 response schema → profile.abhaNumber 14 digits, mobileMasked '******0903', isNew true */ })
it('mobile login returns a transient token and needs an account choice', async () => {
  /* loginVerify → { token: 'T300', accounts: [{ ABHANumber: '91-1111-2222-3333' }] } → userToken null, transientToken 'T300'
     loginSelectAccount sends T-token 'Bearer T300' and body ABHANumber dashed */
})
it('profile fetch sends X-token with the Bearer prefix', async () => {})
it('a 401 on OTP verify is otp_invalid and the body never surfaces', async () => {
  const { gw } = adapter({ [ABDM_PATHS.loginVerify]: json(401, { message: 'otp 654321 invalid for 234123412346' }) })
  const r = await gw.loginVerifyOtp({ route: 'abha_number_aadhaar_otp', txnId: 't', encryptedOtp: 'E' })
  expect(r).toEqual({ ok: false, error: 'otp_invalid' }); expect(JSON.stringify(r)).not.toMatch(/654321|234123412346/)
})
it('times out after 15 s as abdm_unavailable', async () => {})
// mock-adapter.test.ts
it('the mock is labelled and accepts only 123456', async () => { const m = mockAbdmGateway(); expect(m.status().label).toBe('Sandbox mock - not real'); /* wrong OTP → otp_invalid */ })
// registry.test.ts
it('returns null, mock or http by configuration', () => {
  expect(getAbdmGateway({ NODE_ENV: 'production', ABDM_USE_MOCKS: '1' })).toBeNull()
  expect(getAbdmGateway({ NODE_ENV: 'development', ABDM_USE_MOCKS: '1' })!.source).toBe('abdm_sandbox_mock')
  expect(getAbdmGateway(FULL_ABDM)!.source).toBe('abdm')
})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/abdm` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same command, plus `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/abdm tests/lib/abdm
git commit -m "feat(sp8): AbdmGateway with real ABHA V3 adapter, labelled sandbox mock and registry"
```

---

### Task 5: ABHA create/verify/link flows — flow store, consent, routes, patient linking, UI

**Files:**
- Create:
  - `src/lib/abdm/flow-store.ts`, `src/lib/abdm/consent.ts`, `src/lib/queries/abha-link.ts`, `src/lib/validation/abha-flow.ts`.
  - Routes (all `POST`): `src/app/api/abdm/abha/consent/route.ts`, `src/app/api/abdm/abha/enrol/otp/route.ts`, `src/app/api/abdm/abha/enrol/verify/route.ts`, `src/app/api/abdm/abha/enrol/address/route.ts` (also `GET` for suggestions), `src/app/api/abdm/abha/login/otp/route.ts`, `src/app/api/abdm/abha/login/verify/route.ts`, `src/app/api/abdm/abha/login/account/route.ts`, `src/app/api/patients/[anonId]/abha/link/route.ts`.
  - `src/components/abdm/AbhaVerifyDialog.tsx`, `src/components/abdm/AbhaConsentStep.tsx`.
- Modify:
  - `src/components/registration/NationalIdSection.tsx`: add a "Create or verify with ABDM" button that opens the dialog; on success it fills `abhaNumber`/`abhaAddress` and stores `abhaFlowId` in the form state.
  - `src/components/registration/registration-form-state.ts`: `abhaFlowId`.
  - `src/lib/validation/patient-registration.ts`: `abhaInputSchema` `provided` branch gains optional `flowId: z.string().uuid()`.
  - `src/lib/queries/patient-registration.ts`, in a `// SP8` block: when `abha.flowId` is present, call `consumeVerifiedAbha` inside the registration transaction.
  - `src/components/patient-profile/PatientProfilePanel.tsx`: a "Verified with ABDM" badge (`abhaVerifiedAt`), or a "Verify with ABDM" button for `ABHA_LINK_ROLES`.
  - `src/lib/rate-limit.ts`: `checkAbhaRateLimit`.
  - `tests/api/rbac-route-gates.test.ts`: create `SP8_WRITE_GATES` and add it to the deny-before-parse spread.
- Test: `tests/lib/abdm/flow-store.test.ts`, `tests/lib/queries/abha-link.test.ts` (DB), `tests/api/abdm-abha.test.ts`, `tests/components/abdm/AbhaVerifyDialog.test.tsx`

**Interfaces:**
- Consumes: Task 4 `getAbdmGateway`; Task 2 tables; SP1 `identityAuditEntries`, ABHA helpers, `isValidAadhaar`, `normalizeAadhaar`.
- Produces (`flow-store.ts`, server):
  - `interface AbhaFlow { flowId: string; staffName: string; staffUserId: number | null; patientId: string | null; kind: 'enrolment' | LoginRoute; txnId: string | null; userToken: string | null; transientToken: string | null; consentId: number | null; verified: { abhaNumber: string; abhaAddress: string | null; via: AbhaVerifiedVia; source: AbhaVerificationSource } | null; accounts: string[] }`
  - `createFlow(init: Pick<AbhaFlow, 'staffName' | 'staffUserId' | 'patientId' | 'kind'>): Promise<AbhaFlow>`, `getFlow(flowId: string, staffName: string): Promise<AbhaFlow | null>` (null when the staff member differs), `saveFlow(flow: AbhaFlow): Promise<void>`, `deleteFlow(flowId: string): Promise<void>`.
  - Redis key `abdm:flow:<flowId>`, value `sealPayload(JSON)` (Task 1 vault), TTL **900 s** (under the 1800 s token life, S1).
  - `AbhaFlow` has no field that can hold an Aadhaar number or OTP. Its type is the guard, and the Task 16 static test checks it.
- Produces (`consent.ts`): `loadConsentText(cfg: AbdmConfig | null): { text: string; sha256: string } | null`.
  - It reads the UTF-8 file at `cfg.consentTextPath`, or `docs/abdm/abha-enrolment-consent-1.4.txt` when unset. Null when the file is missing.
  - The text is **not** in the repo. The owner installs it verbatim from NHA (S1 M1 test case CRT_ABHA_102: "show the full consent text and collect consent before the Aadhaar number is sent"). See UNVERIFIED U16.
  - The mock gateway uses the fixed text `'SANDBOX MOCK CONSENT - not the NHA text'`.
- Produces (`validation/abha-flow.ts`, `.strict()` objects):
  - `consentSchema = { flowId?: uuid, patientId?: trim 1..40, purpose: enum ABDM_CONSENT_PURPOSES, givenBy: enum ['patient','guardian'], textSha256: /^[0-9a-f]{64}$/ }`
  - `enrolOtpSchema = { flowId: uuid, aadhaar: string }`. `aadhaar` is checked with `isValidAadhaar(normalizeAadhaar(v))`, with the fixed message `'Enter a valid 12-digit Aadhaar number'` and no value echoed.
  - `enrolVerifySchema = { flowId: uuid, otp: /^\d{6}$/, mobile: /^[6-9]\d{9}$/ }`
  - `addressSchema = { flowId: uuid, abhaAddress: string refined by isValidAbhaAddress }`
  - `loginOtpSchema = { flowId?: uuid, patientId?: trim 1..40, route: enum LoginRoute, loginId: string }`. `loginId` is refined per route:
    - `abha_number_*`: `isValidAbhaNumber`, sent dashed;
    - `mobile_otp`: `/^[6-9]\d{9}$/`;
    - `aadhaar_otp_login`: `isValidAadhaar`;
    - `abha_address_otp`: `isValidAbhaAddress`.
  - `loginVerifySchema = { flowId: uuid, otp: /^\d{6}$/ }`; `accountSchema = { flowId: uuid, abhaNumber: refined isValidAbhaNumber }`; `linkSchema = { flowId: uuid }`.
- Produces (`abha-link.ts`):
  - `recordConsent(input: ConsentInput & { flowId: string }, session: Session): Promise<{ consentId: number }>`: inserts `abdm_consents` with `consentCode/Version` from `ENROL_CONSENT`. Audit `abdm: recorded ABHA consent`, details `consent=<id> purpose=<p> given_by=<g>`.
  - `applyVerifiedAbha(patientId: string, flow: AbhaFlow, session: Session): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'abha_conflict' | 'flow_not_verified' }>`:
    - one transaction: lock the patient row; set `abhaNumber`, `abhaAddress` (keeping the existing one when the flow has none), `abhaUnavailableReason/Note = null`, `abhaVerifiedAt = now`, `abhaVerificationSource`, `abhaVerifiedVia`;
    - update the flow's consent row `patient_id` when null;
    - SP1 `identityAuditEntries(before, after, false)` audit rows, plus `abdm: verified ABHA` with details `patient=<id> via=<via> source=<source>`;
    - a unique violation → `abha_conflict`.
  - `consumeVerifiedAbha(tx: WriteExecutor, patientId: string, flowId: string, staffName: string): Promise<void>`: the registration path. It applies the same verification columns when the flow is verified and its number equals the submitted one. Otherwise it does nothing, and the patient stays "recorded, not verified".
- **Route contract** (every route):
  1. `requireSession()`; then the `ABHA_LINK_ROLES` gate.
  2. `checkAbhaRateLimit(session.name)`: sliding window 10 per 60 s per staff member, plus 60 per 600 s globally. Denied → 429 `ABDM_ERROR_COPY.rate_limited`.
  3. `readJsonBody`, then the zod schema.
  4. `getAbdmGateway()` null → 503 `ABDM is not configured`.
  5. The flow is loaded for this staff member (`flow_expired` 410 when missing).
  6. Gateway errors → 502 or 400 with `ABDM_ERROR_COPY[error]`.

  Responses never carry tokens or txnIds. They carry only `{ flowId, step, suggestions?, accounts? (masked as XX-XXXX-XXXX-1234), profile? (name, gender, yearOfBirth, abhaNumber formatted, abhaAddress) }`.
  - `consent`: creates the flow when `flowId` is absent. For `purpose = 'abha_enrolment'`, `loadConsentText` must be non-null and its sha256 must equal `textSha256` (409 `consent_text_missing` / 400 `consent_missing`). Response `{ flowId, consentId }`.
  - `enrol/otp`: the flow's `consentId` must be present (`consent_missing`). Then `const encryptedAadhaar = await gw.encrypt(body.aadhaar)` is called **in the expression that reads the body**; save `txnId`; respond `{ flowId, step: 'otp_sent' }`.
  - `enrol/verify`: encrypt the OTP; `enrolByAadhaarOtp`; store `userToken` and `verified` (`via: 'aadhaar_otp_enrolment'`); respond with the profile and `suggestions`.
  - `enrol/address`: GET → suggestions; POST → `enrolSetAddress`, which updates `verified.abhaAddress`.
  - `login/otp`: when the route is `aadhaar_otp_login` or `abha_number_aadhaar_otp`, a consent row (`abha_verification`) must exist; encrypt `loginId`; respond `{ flowId, step: 'otp_sent' }`.
  - `login/verify`: on success either `{ step: 'choose_account', accounts }` (mobile) or the profile (the verified profile is fetched, then `verified` is set).
  - `login/account`: `loginSelectAccount`, then `fetchProfile`.
  - `patients/[anonId]/abha/link`: the flow must be verified and belong to this staff member; `applyVerifiedAbha`; `deleteFlow`; 200 `{ ok: true }`, 409 `abha_conflict`, 404.
  - Audit actions (each with details `flow=<first 8 of flowId>` plus the route or step only):
    - `abdm: requested ABHA enrolment OTP`
    - `abdm: created ABHA`
    - `abdm: requested ABHA login OTP`
    - `abdm: verified ABHA login`
  - Each is written with `patientId` when known. These rows come from `logAudit` outside a transaction (no DB change accompanies them).
- **`AbhaVerifyDialog({ patientId, mode: 'register' | 'profile', onVerified(v: { abhaNumber: string; abhaAddress: string | null; flowId: string }) })`**: steps choose method → consent (shows the loaded text verbatim with a sha-bound "Patient agrees" / "Guardian agrees" choice) → OTP → (account choice) → (address choice) → confirm.
  - The Aadhaar input uses `type="password"`, `autoComplete="off"` and `inputMode="numeric"`, and is cleared from component state right after the request resolves.
  - A `Sandbox mock - not real` badge shows when the server reports the mock.
  - When ABDM is not configured, the button is disabled with the title `ABDM not connected`, and SP1's hint stays.

- [ ] **Step 1: Write the failing tests**

```ts
// flow-store.test.ts (fake redis)
it('stores sealed state with a 900 s TTL and refuses another staff member', async () => {
  const f = await createFlow({ staffName: 'A', staffUserId: 1, patientId: null, kind: 'enrolment' })
  expect(redis.set).toHaveBeenCalledWith(`abdm:flow:${f.flowId}`, expect.not.stringContaining('enrolment'), { ex: 900 })
  expect(await getFlow(f.flowId, 'B')).toBeNull()
})
// abdm-abha.test.ts (gateway + flow store + queries mocked)
it('billing, pharmacy, labs, coder, rcm get 403 before the body is read', async () => {})
it('503 when ABDM is not configured', async () => { vi.mocked(getAbdmGateway).mockReturnValue(null); expect((await post('enrol/otp', BODY)).status).toBe(503) })
it('an Aadhaar OTP request leaves no trace in the flow store, the audit row or the response', async () => {
  const res = await post('enrol/otp', { flowId: F, aadhaar: '2341 2341 2346' })
  const everything = JSON.stringify([await res.json(), saveFlow.mock.calls, logAudit.mock.calls, consoleSpy.mock.calls, gw.enrolRequestAadhaarOtp.mock.calls])
  expect(everything).not.toMatch(/234123412346|2341 2341 2346/)
  expect(gw.encrypt).toHaveBeenCalledWith('2341 2341 2346'.replace(/\s/g, ''))
})
it('a malformed Aadhaar is refused without echoing it', async () => { const r = await post('enrol/otp', { flowId: F, aadhaar: '1234 5678 9012' }); expect(r.status).toBe(400); expect(await r.text()).not.toContain('1234') })
it('enrolment needs consent first, and the installed consent text', async () => { /* no consentId → 400 consent_missing; loadConsentText null → 409 consent_text_missing */ })
it('the OTP never appears in responses or logs', async () => {})
it('responses carry no token or txnId', async () => { /* enrol/verify → body has no 'userToken'|'txnId'|'T1' */ })
it('mobile login asks for an account and masks the choices', async () => { /* accounts ['XX-XXXX-XXXX-3333'] */ })
it('a 429 after 10 attempts per minute', async () => {})
// abha-link.test.ts (DB)
it('linking a verified flow sets number, address and verification columns with an audit row carrying no number', async () => {
  /* audit rows: SP1 'set ABHA number' + 'abdm: verified ABHA' with details 'patient=<id> via=abha_number_aadhaar_otp source=abdm'; no row contains the 14 digits */
})
it('linking an ABHA already on another patient is a conflict', async () => {})
it('registration with a verified flowId stamps verification; without it the ABHA is unverified', async () => {})
it('a flow verified for number X does not verify a registration typed with number Y', async () => {})
// AbhaVerifyDialog.test.tsx
it('shows the consent text verbatim and blocks the Aadhaar step until consent', async () => {})
it('clears the Aadhaar field after the OTP request', async () => {})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/abdm/flow-store.test.ts tests/api/abdm-abha.test.ts tests/components/abdm`, `npm test -- tests/lib/queries/abha-link.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Add `API_GATES` rows for all eight routes and `SP8_WRITE_GATES` rows for each POST.
- [ ] **Step 4: Verify:** same commands, plus `npm test -- tests/api/rbac-route-gates.test.ts tests/lib/queries/patient-registration.test.ts`, plus `npx vitest run tests/lib/no-aadhaar-leak.test.ts tests/components/registration`, plus `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/abdm src/lib/queries/abha-link.ts src/lib/validation/abha-flow.ts src/lib/validation/patient-registration.ts src/lib/queries/patient-registration.ts src/lib/rate-limit.ts src/app/api/abdm src/app/api/patients src/components/abdm src/components/registration src/components/patient-profile tests
git commit -m "feat(sp8): ABHA create, verify and link flows with consent, encrypted pass-through and no Aadhaar or OTP retention"
```

---

### Task 6: Scan & Share — HIP profile-share callback, on-share token, registration queue

**Files:**
- Create: `src/lib/abdm/callback-auth.ts`, `src/lib/queries/abdm-profile-shares.ts`, `src/app/api/abdm/api/v3/hip/patient/share/route.ts`, `src/app/api/abdm/shares/[id]/route.ts` (POST resolve), `src/app/(dashboard)/front-desk/abdm-shares/page.tsx`, `src/components/abdm/ProfileShareQueue.tsx`
- Modify: `src/components/LeftNav.tsx` (`// SP8`: `{ href: '/front-desk/abdm-shares', label: 'ABHA Scan & Share', icon: QrCode, roles: ['admin', 'frontdesk'] }`), `src/app/(dashboard)/front-desk/...` registration entry (the `?share=<id>` query pre-fills the registration form from the share), `tests/pages/page-gates-harness.ts`, `tests/api/rbac-route-gates.test.ts`
- Test: `tests/lib/abdm/callback-auth.test.ts`, `tests/api/abdm-share-callback.test.ts`, `tests/lib/queries/abdm-profile-shares.test.ts` (DB), `tests/pages/abdm-shares.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`readAbdmConfig`, `logGatewayEvent`, `safeLog`), Task 3 (`abdmHeaders`, `getGatewayToken`), Task 2 table.
- Produces (`callback-auth.ts`): `verifyAbdmCallback(request: Request, cfg: AbdmConfig, deps?: { jwks?: JWTVerifyGetKey; now?: Date }): Promise<{ ok: true } | { ok: false; status: 401 | 403 | 503 }>`. Steps:
  1. `cfg.gatewayJwksUrl` missing → 503.
  2. `Authorization: Bearer <jwt>` must be present → else 401.
  3. `jwtVerify(jwt, createRemoteJWKSet(new URL(cfg.gatewayJwksUrl)), { algorithms: ['RS256'], clockTolerance: 60 })` → else 401. RS256 with a `kid` is [observed, annex] in S1. The key URL is UNVERIFIED U13: the v3 certs endpoint needs the session token, so in production the operator sets `ABDM_GATEWAY_JWKS_URL` to a URL NHA confirms. If the URL needs a token, `deps.jwks` is built in `route.ts` with a fetch that adds `Authorization: Bearer <gateway token>`.
  4. The `X-HIP-ID` header must equal `cfg.hipId` → else 403.
- Produces (`abdm-profile-shares.ts`):
  - `recordProfileShare(input: { requestId: string; hipId: string; counterId: string; intent: string; profile: ShareProfile; isMock: boolean }, now?: Date): Promise<{ shareId: number; tokenNumber: number; duplicate: boolean }>`:
    - The token is `max(tokenNumber) + 1` for `(istDateOf(now), counterId)` under `pg_advisory_xact_lock(hashtext('abdm:token:' || date || counter))`.
    - A duplicate `requestId` returns the existing row with `duplicate: true` (ABDM retries callbacks, S1).
    - `logGatewayEvent('ABDM gateway', 'abdm: received profile share', null, 'share=<id> counter=<c> intent=<i>', tx)`.
  - `sendOnShare(shareId: number, deps?): Promise<void>`: POSTs `${cfg.gatewayBaseUrl}${ABDM_PATHS.onShare}` with `abdmHeaders({ 'X-CM-ID': cfg.cmId, Authorization: 'Bearer <token>' })` and body `{ acknowledgement: { status: 'SUCCESS', abhaAddress, profile: { context: counterId, tokenNumber: String(tokenNumber), expiry: 1800 } }, response: { requestId } }`. It sets `ackState` to `sent` or `failed`.
    - The body shape is from S1 `hiecm-scan-and-register.yaml`. The meaning and unit of `expiry` are UNVERIFIED U17; 1800 is used.
  - `listPendingShares(now?: Date): Promise<ShareQueueRow[]>`: pending rows from the last 24 h. Each row has the token number, name, gender, year of birth, masked ABHA (`XX-XXXX-XXXX-1234`), ABHA address, and an `existingPatientId` match on `abhaNumber`/`abhaAddress`.
  - `resolveShare(shareId: number, input: { action: 'registered' | 'linked' | 'dismissed'; patientId?: string }, session: Session): Promise<{ ok: boolean; error?: 'not_found' | 'already_resolved' | 'patient_required' }>`:
    - `linked` applies `applyVerifiedAbha`-equivalent columns with `via: 'scan_and_share'` and `source` from `isMock`.
    - `registered` is set by the registration route after the patient is created from `?share=<id>`.
    - Audit `abdm: resolved profile share`, details `share=<id> action=<a>`.
  - `expireShares(now: Date): Promise<number>`: rows older than 24 h with status `pending` → `expired`, and every profile column nulled (the check constraint enforces this). Called by the Task 13 sweep.
- **Callback route `POST /api/abdm/api/v3/hip/patient/share`.** The path is `{bridgeUrl}/api/v3/hip/patient/share`, with `bridgeUrl = <app>/api/abdm` (S1). No session. Order:
  1. `content-length` > 16 KB → 413 `{ error: 'Payload too large' }`.
  2. Rate limit 60 per 60 s per IP (`x-forwarded-for` first hop) → 429.
  3. `verifyAbdmCallback` → 401, 403 or 503 with `{ error: 'Unauthorized' }` / `{ error: 'Forbidden' }` / `{ error: 'Scan and share is not configured' }`.
  4. Parse JSON → 400 `{ error: 'Invalid request' }`.
  5. zod with `intent`, `metaData { hipId, context: /^[A-Za-z0-9]{1,20}$/ }` and `profile.patient {...}` (non-strict outer, strict known fields) → 400 `{ error: 'Invalid request' }`.
  6. `recordProfileShare`.
  7. `after(() => sendOnShare(id))`.
  8. 202 `{}`.

  Bodies are fixed strings. Nothing from the request is echoed.
- Page `/front-desk/abdm-shares`:
  - Gate `ABDM_SHARE_QUEUE_ROLES`; polls every 15 s via `router.refresh()`.
  - Each row offers "Register" (→ registration form pre-filled), "Link to <UHID>" when it matches, and "Dismiss".
  - It shows the facility QR URL text from `docs/ABDM-NHCX.md` (no image library).

- [ ] **Step 1: Write the failing tests**

```ts
// callback-auth.test.ts (local JWKS via jose generateKeyPair + createLocalJWKSet)
it('503 without a JWKS URL; 401 without or with a bad bearer; 403 for another HIP', async () => {})
// abdm-share-callback.test.ts
it('a duplicate REQUEST-ID returns 202 and writes once', async () => {})
it('an oversized body is refused before parsing', async () => { /* content-length 20000 → 413, verifyAbdmCallback not called */ })
it('a valid share is stored, gets token 1 then 2 for the counter, and on-share is scheduled', async () => {})
it('error bodies are fixed and never echo the profile', async () => {})
// abdm-profile-shares.test.ts (DB)
it('token numbers restart per IST day and per counter', async () => {})
it('expired shares are scrubbed', async () => {})
it('linking a share verifies the patient ABHA via scan_and_share', async () => {})
// abdm-shares.test.tsx — PAGE_GATES ['admin','frontdesk']; masked ABHA only
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/abdm/callback-auth.test.ts tests/api/abdm-share-callback.test.ts tests/pages/abdm-shares.test.tsx`, `npm test -- tests/lib/queries/abdm-profile-shares.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Add the harness rows (`API_GATES` and `SP8_WRITE_GATES` for `/api/abdm/shares/[id]`; `PAGE_GATES`), and the nav entry.
- [ ] **Step 4: Verify:** same commands, plus `npm test -- tests/api/rbac-route-gates.test.ts`, plus `npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/components/LeftNav.test.tsx`, plus `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/abdm/callback-auth.ts src/lib/queries/abdm-profile-shares.ts src/app/api/abdm "src/app/(dashboard)/front-desk" src/components/abdm src/components/LeftNav.tsx tests
git commit -m "feat(sp8): ABHA Scan & Share callback with JWT check, token numbers, on-share and front-desk queue"
```

---

### Task 7: NHCX protocol headers and JWE seal/open

**Files:**
- Create: `src/lib/nhcx/headers.ts`, `src/lib/nhcx/jwe.ts`
- Modify: `src/lib/nhcx/constants.ts`
- Test: `tests/lib/nhcx/headers.test.ts`, `tests/lib/nhcx/jwe.test.ts`

**Interfaces:**
- Produces (`constants.ts`):
  - `NHCX_API_VERSION_PREFIX = '/v1'` (S2 Swagger).
  - `NHCX_ACTIONS` (as const). Each entry is `{ path, entity, direction: 'request' | 'callback' }`:
    - `coverageeligibility/check`, `coverageeligibility/on_check`
    - `preauth/submit`, `preauth/on_submit`
    - `claim/submit`, `claim/on_submit`
    - `communication/request`, `communication/on_request`
    - `paymentnotice/request`, `paymentnotice/on_request`
    - `status`, `on_status`

    Paths are prefixed with `NHCX_API_VERSION_PREFIX` when sent. S2 has `/v1/status`; `on_status` is UNVERIFIED U9. There is no `predetermination` path in NHCX (S2).
  - `ACCEPTED_INBOUND_ACTIONS = ['coverageeligibility/on_check', 'preauth/on_submit', 'claim/on_submit', 'communication/request', 'paymentnotice/request', 'on_status']`. A provider never accepts `*/submit` or `*/check`.
  - `HCX_HEADER` (S4) = `{ sender: 'x-hcx-sender_code', recipient: 'x-hcx-recipient_code', apiCallId: 'x-hcx-api_call_id', correlationId: 'x-hcx-correlation_id', workflowId: 'x-hcx-workflow_id', timestamp: 'x-hcx-timestamp', status: 'x-hcx-status', errorDetails: 'x-hcx-error_details', debugFlag: 'x-hcx-debug_flag', abhaId: 'x-hcx-ben-abha-id' }`. The ABHA header is from S3 only (UNVERIFIED U19). It is sent only when the snapshot carries ABHA.
  - `HCX_STATUS_VALUES = ['request.initiated', 'request.queued', 'request.dispatched', 'request.stopped', 'response.complete', 'response.partial', 'response.error', 'response.redirect']`. S4 lists queued, dispatched and the four response values; S3 adds `request.initiated` and `request.stopped`.
  - `JWE_ALG_SEND = 'RSA-OAEP-256'`, `JWE_ALGS_ACCEPT = ['RSA-OAEP-256', 'RSA-OAEP']`, `JWE_ENC = 'A256GCM'`. S4 fixes `RSA-OAEP`; S3 says NHCX sends `RSA-OAEP-256` and accepts both (UNVERIFIED U4). One constant to flip.
  - `NHCX_SEND_WORKFLOW_ID = false`. S3 claims numeric stage codes; unverified (U5), so the optional header is omitted.
  - `NHCX_TOKEN_HEADER = 'bearer_auth'`. S3 only, UNVERIFIED U1; one constant.
- Produces (`headers.ts`, pure):
  - `interface ProtocolHeaders { sender: string; recipient: string; apiCallId: string; correlationId: string; timestamp: string; status: HcxStatus; abhaId?: string; workflowId?: string }`
  - `buildRequestHeaders(i: { sender: string; recipient: string; apiCallId?: string; correlationId?: string; abhaId?: string | null; now: Date; status?: HcxStatus }): ProtocolHeaders`:
    - `apiCallId` and `correlationId` each default to a new `randomUUID()`. The outbox passes the exchange row's stored ids;
    - `timestamp = istIsoWithOffset(now)` (e.g. `2026-10-08T11:32:26.605+05:30`);
    - `status` defaults to `'request.initiated'`;
    - `abhaId` is included only when given and dashed;
    - `workflowId` is never set while `NHCX_SEND_WORKFLOW_ID` is false.
  - `toJoseHeader(h: ProtocolHeaders): Record<string, string>` maps the fields to their `x-hcx-*` names.
  - `parseProtocolHeaders(raw: Record<string, unknown>): { ok: true; headers: ProtocolHeaders & { errorDetails?: { code: string; message: string } } } | { ok: false; problem: 'missing_header' | 'bad_uuid' | 'bad_timestamp' | 'bad_status' }`.
  - `istIsoWithOffset(d: Date): string`.
  - `timestampWithin(ts: string, now: Date, toleranceSeconds = 600): boolean`.
- Produces (`jwe.ts`, server, `jose` only):
  - `sealHcxPayload(fhir: object, headers: ProtocolHeaders, recipientCertPem: string): Promise<string>`: `new CompactEncrypt(utf8(JSON.stringify(fhir))).setProtectedHeader({ alg: JWE_ALG_SEND, enc: JWE_ENC, ...toJoseHeader(headers) }).encrypt(await importX509(recipientCertPem, JWE_ALG_SEND))`. Named differently from the vault's `sealPayload` on purpose.
  - `openHcxPayload(compact: string, privateKeysPem: string[]): Promise<{ ok: true; protectedHeader: Record<string, unknown>; fhir: unknown } | { ok: false; problem: 'decrypt_failed' | 'bad_alg' | 'not_json' }>`:
    - tries each key in order (current, then previous) with `compactDecrypt(compact, key, { keyManagementAlgorithms: JWE_ALGS_ACCEPT, contentEncryptionAlgorithms: [JWE_ENC] })`;
    - `importPKCS8` with the alg from the decoded protected header;
    - a header alg outside the accept list → `bad_alg` **before** any key is tried.
  - `envelope(compact: string): { payload: string }` (S4 request body shape).

- [ ] **Step 1: Write the failing tests**

```ts
// headers.test.ts
it('builds request headers with fresh ids, IST timestamp and no workflow id', () => {
  const h = buildRequestHeaders({ sender: 'P1@sbx', recipient: 'TPA1@sbx', now: new Date('2026-10-08T06:02:26.605Z') })
  expect(h.timestamp).toBe('2026-10-08T11:32:26.605+05:30'); expect(h.apiCallId).toMatch(UUID); expect(h.status).toBe('request.initiated')
  expect(toJoseHeader(h)).not.toHaveProperty('x-hcx-workflow_id'); expect(toJoseHeader(h)['x-hcx-recipient_code']).toBe('TPA1@sbx')
})
it('keeps a given correlation id', () => { expect(buildRequestHeaders({ ...BASE, correlationId: C }).correlationId).toBe(C) })
it('parses and rejects protocol headers', () => {
  expect(parseProtocolHeaders({ ...VALID, 'x-hcx-api_call_id': 'nope' })).toEqual({ ok: false, problem: 'bad_uuid' })
  expect(parseProtocolHeaders({ ...VALID, 'x-hcx-status': 'done' })).toEqual({ ok: false, problem: 'bad_status' })
})
// jwe.test.ts
it('round-trips a sealed payload and exposes the protocol headers', async () => {
  const { certPem, privateKeyPem } = makeTestKeyPairAndCert('TPA1@sbx', 30)
  const jwe = await sealHcxPayload({ resourceType: 'Bundle' }, H, certPem)
  const r = await openHcxPayload(jwe, [privateKeyPem]); expect(r).toMatchObject({ ok: true, fhir: { resourceType: 'Bundle' }, protectedHeader: { alg: 'RSA-OAEP-256', enc: 'A256GCM', 'x-hcx-sender_code': 'P1@sbx' } })
})
it('a payload sealed for the previous key still opens during rotation', async () => {})
it('accepts RSA-OAEP from a v0.8 sender and refuses dir/ECDH before trying keys', async () => {})
it('a tampered ciphertext fails closed', async () => {})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/nhcx/headers.test.ts tests/lib/nhcx/jwe.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same command, plus `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/nhcx tests/lib/nhcx
git commit -m "feat(sp8): HCX protocol headers and JWE seal/open with jose and key rotation"
```

---

### Task 8: NHCX HTTP client — token, recipient certificates, sealed POST with retry and backoff

**Files:**
- Create: `src/lib/nhcx/client.ts`, `src/lib/nhcx/participants.ts`
- Test: `tests/lib/nhcx/client.test.ts`, `tests/lib/nhcx/participants.test.ts`

**Interfaces:**
- Consumes: Task 3 `getGatewayToken`, `abdmHeaders`; Task 7; Task 1 `readNhcxConfig`, `safeLog`.
- Produces (`client.ts`):
  - `interface NhcxDeps { fetch: typeof fetch; now: () => Date; sleep: (ms: number) => Promise<void> }`
  - `type PostOutcome = { kind: 'accepted'; httpStatus: 202; apiCallId: string; correlationId: string } | { kind: 'rejected'; httpStatus: number; errorCode: string | null } | { kind: 'retryable'; httpStatus: number | null; errorCode: string | null }`
  - `postSealed(cfg: NhcxConfig, abdm: AbdmConfig, action: NhcxAction, compactJwe: string, deps?: NhcxDeps): Promise<PostOutcome>`: one attempt.
    - Request: `POST ${cfg.apiBaseUrl}${NHCX_API_VERSION_PREFIX}/${action}` with headers `{ 'Content-Type': 'application/json', [NHCX_TOKEN_HEADER]: 'Bearer <token>' }`, `abdmHeaders()` fields `REQUEST-ID`/`TIMESTAMP`/`X-CM-ID` (S3, UNVERIFIED U1/U3), and body `envelope(compactJwe)`.
    - 30-second timeout.
    - 202 → parse `{ api_call_id, correlation_id }` (S4 `SuccessResponse`) → `accepted`.
    - 400/401/403/404/409/422 → `rejected` with `error.code` from S4 `ErrorResponse` or the NHCX code from S3. The code is kept only if it matches `/^[A-Z][A-Z0-9_-]{2,40}$/`.
    - 408/425/429/5xx/network/timeout → `retryable`.
    - A 401 clears the gateway token cache once and retries immediately, within the same attempt.
  - `RETRY_SCHEDULE_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000]`; `MAX_SEND_ATTEMPTS = 5`.
  - `nextAttemptAt(attempts: number, now: Date, jitter?: () => number): Date | null`: `now + RETRY_SCHEDULE_MS[attempts - 1] × (1 + jitter() × 0.2)`; null once `attempts >= MAX_SEND_ATTEMPTS`.
  - Ruling 5: a retry resends **the same stored JWE** (same `api_call_id` and correlation id), so a duplicate that did reach NHCX is recognisable on their side. Whether NHCX dedupes is UNVERIFIED U11.
- Produces (`participants.ts`):
  - `getRecipientCert(cfg: NhcxConfig, abdm: AbdmConfig, participantCode: string, deps?): Promise<{ ok: true; certPem: string } | { ok: false; error: 'participant_not_found' | 'participant_inactive' | 'cert_unavailable' }>`.
  - It POSTs `${cfg.participantServiceUrl}/participant/search` with `{ filters: { participant_code: { eq: participantCode } } }`. The body shape is S4 registry `openapi_hcx_registry.yml`; that the same filter works on the NHCX participant service (S2 lists `/participant/search`) is UNVERIFIED U10.
  - It reads `participants[0].status` (`Active` required), then `encryption_cert`: a URL fetched over https only, or an inline base64 PEM.
  - Redis cache `nhcx:cert:<code>` for 24 h (S3), keyed by participant code; a cert that fails `certificateSummary` or is expired → `cert_unavailable`.
  - `invalidateRecipientCert(code)` is called when the recipient answers `ERR_INVALID_ENCRYPTION` or `PAYR-1001` (S4/S3).

- [ ] **Step 1: Write the failing tests**

```ts
// client.test.ts
it('posts the JWE envelope with the token header and parses the 202', async () => {
  const fetch = fakeFetch({ status: 202, body: { timestamp: 't', api_call_id: A, correlation_id: C } })
  expect(await postSealed(NCFG, ACFG, 'claim/submit', 'a.b.c.d.e', deps(fetch))).toEqual({ kind: 'accepted', httpStatus: 202, apiCallId: A, correlationId: C })
  const [url, init] = fetch.mock.calls.at(-1); expect(url).toBe('https://hcx.example/v1/claim/submit'); expect(JSON.parse(init.body)).toEqual({ payload: 'a.b.c.d.e' }); expect(init.headers.bearer_auth).toBe('Bearer GW')
})
it('classifies 4xx as rejected with a sanitised code and 5xx/timeouts as retryable', async () => {
  expect(await postSealed(...withStatus(400, { error: { code: 'ERR_INVALID_PAYLOAD', message: 'patient 234123412346' } }))).toEqual({ kind: 'rejected', httpStatus: 400, errorCode: 'ERR_INVALID_PAYLOAD' })
  expect((await postSealed(...withStatus(503, {}))).kind).toBe('retryable'); expect((await postSealed(...networkError())).kind).toBe('retryable')
})
it('a 401 refreshes the gateway token once', async () => {})
it('backs off 1 m, 5 m, 15 m, 1 h, 6 h then gives up', () => {
  const now = new Date(0); expect(nextAttemptAt(1, now, () => 0)!.getTime()).toBe(60_000); expect(nextAttemptAt(5, now, () => 0)!.getTime()).toBe(21_600_000); expect(nextAttemptAt(6, now, () => 0)).toBeNull()
})
// participants.test.ts
it('looks up an active participant cert and caches it for 24 h', async () => {})
it('an inactive or unknown participant is refused', async () => {})
it('an expired recipient cert is unavailable', async () => {})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/nhcx/client.test.ts tests/lib/nhcx/participants.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same command, plus `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/nhcx tests/lib/nhcx
git commit -m "feat(sp8): NHCX sealed POST client with token, recipient cert cache, error classification and backoff"
```

---

### Task 9: FHIR NHCX base resources, CoverageEligibility bundle and the structural validator

**Files:**
- Create: `src/lib/fhir/nhcx/{systems,money,resources,eligibility,validate}.ts`
- Create `tests/fixtures/nhcx/`: de-identified copies of the S5 6.5.0 examples. Download each from `https://nrces.in/ndhm/fhir/r4/<name>.json`, e.g. `https://nrces.in/ndhm/fhir/r4/Bundle-ClaimBundle-preauthorization-example-01.json`. The files:
  - `Bundle-CoverageEligibilityRequestBundle-validation-example-01.json`
  - `Bundle-CoverageEligibilityResponseBundle-validation-example-01.json`
  - `Bundle-ClaimBundle-preauthorization-example-01.json`
  - `Bundle-ClaimBundle-enhancement-example-01.json`
  - `Bundle-ClaimBundle-settlement-example-01.json`
  - `Bundle-ClaimResponseBundle-preauthorization-example-01.json`
  - `Bundle-ClaimResponseBundle-settlement-example-01.json`
  - `Bundle-TaskBundleForCommunicationRequest-example-01.json`
  - `Bundle-TaskBundleForCommunicationResponse-example-01.json`
  - `Bundle-TaskBundleForPaymentNoticeRequest-example-01.json`
  - `Bundle-TaskBundleForPaymentNoticeResponse-example-01.json`

  Alternatively, take them from the package tarball (`https://nrces.in/ndhm/fhir/r4/package.tgz`, `package/example/`).
  - **De-identification (mandatory):** the official examples identify the patient by Aadhaar (`type` code `ADN`, system `https://uidai.gov.in/`). Replace every such identifier with `{ "type": { "coding": [{ "system": "https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code", "code": "ABHA", "display": "Ayushman Bharat Health Account (ABHA) ID" }] }, "system": "https://healthid.ndhm.gov.in", "value": "91-0000-0000-0001" }`, and strip any remaining 12-digit numbers.
  - Record the source URL, the package version and the transform in `tests/fixtures/nhcx/README.md`.
  - If a download returns 404, stop and report.
- Modify: `src/lib/fhir/identifier-systems.ts`
  - `ABHA_NUMBER_SYSTEM = 'https://healthid.ndhm.gov.in'`, verified against S5 `Patient-example-01`. Comment: `// Verified: NRCeS FHIR IG for ABDM 6.5.0, Patient-example-01`.
  - `ABHA_ADDRESS_SYSTEM` is **removed**: no S5 example carries an ABHA-address system (UNVERIFIED U14).
  - Update `src/lib/fhir/patient.ts` to emit the ABHA address identifier with `type: { text: 'ABHA Address' }` and no `system`, and update its tests.
- Test: `tests/lib/fhir/nhcx/resources.test.ts`, `tests/lib/fhir/nhcx/eligibility.test.ts`, `tests/lib/fhir/nhcx/validate.test.ts`, `tests/lib/fhir/patient-mapping.test.ts` (update)

**Interfaces:**
- Consumes: SP7 `ClaimSnapshot['hospital' | 'patient' | 'policy']`, `PayerRef`; SP6 `fhirSystemFor`, `isSampleVersion`; SP1 `uhidSystem`, `formatAbhaNumber`.
- Produces (`systems.ts`, all from S5 6.5.0 unless marked):
  - `NRCES = 'https://nrces.in/ndhm/fhir/r4'`; `PROFILE = { Claim, ClaimBundle, ClaimResponse, ClaimResponseBundle, Coverage, CoverageEligibilityRequest, CoverageEligibilityRequestBundle, CoverageEligibilityResponse, CoverageEligibilityResponseBundle, Communication, CommunicationRequest, PaymentNotice, Task, TaskBundle, Patient, Organization, Practitioner }`, each `${NRCES}/StructureDefinition/<Name>`.
  - CodeSystems:
    - `CS_IDENTIFIER_TYPE = ${NRCES}/CodeSystem/ndhm-identifier-type-code`, `CS_SUPPORTINGINFO_CATEGORY`, `CS_SUPPORTINGINFO_CODE`, `CS_TASK_CODES`, `CS_TASK_OUTPUT_TYPE`, `CS_TASK_OUTPUT_VALUE`, `CS_ADJUDICATION_REASON`, `CS_RELATED_CLAIM`.
    - `V2_0203 = 'http://terminology.hl7.org/CodeSystem/v2-0203'`, `SNOMED = 'http://snomed.info/sct'`, `PROCESS_PRIORITY = 'http://terminology.hl7.org/CodeSystem/processpriority'`, `ACT_CODE = 'http://terminology.hl7.org/CodeSystem/v3-ActCode'`, `SUBSCRIBER_RELATIONSHIP = 'http://terminology.hl7.org/CodeSystem/subscriber-relationship'`, `ORG_TYPE = 'http://terminology.hl7.org/CodeSystem/organization-type'`, `ADJUDICATION = 'http://terminology.hl7.org/CodeSystem/adjudication'`, `FINANCIAL_TASK_INPUT = 'http://terminology.hl7.org/CodeSystem/financialtaskinputtype'`, `FINANCIAL_TASK_CODE = 'http://terminology.hl7.org/CodeSystem/financialtaskcode'`, `COMM_CATEGORY = 'http://terminology.hl7.org/CodeSystem/communication-category'`.
  - Identifier systems:
    - `HFR_SYSTEM = 'https://facility.ndhm.gov.in'` (S5 Organization example, type v2-0203 `PRN`);
    - `ROHINI_SYSTEM = 'https://rohini.iib.gov.in/'` (S5 ClaimBundle example, type `CS_IDENTIFIER_TYPE` `ROHINI`);
    - `PRACTITIONER_SYSTEM = 'https://doctor.ndhm.gov.in'` (S5, type v2-0203 `MD`).
  - Hospital-local namespaces (honest, our own; whether payers accept them is UNVERIFIED U15): `localSystem(kind: 'service-code' | 'policy-number' | 'payer-code' | 'claim-number' | 'eligibility' | 'communication'): string` = `${NEXT_PUBLIC_APP_URL}/fhir/sid/<kind>`, falling back to `urn:x-local:<kind>` (same pattern as `uhidSystem`).
  - `CLAIM_TYPE_CODING: Record<ClaimType, FhirCoding>`, from S5 `ndhm-claim-type`:
    - ipd `{ system: SNOMED, code: '737481003', display: 'Inpatient care management (procedure)' }`
    - daycare `{ code: '737850002', display: 'Day care case management (procedure)' }`
    - opd `{ code: '737492002', display: 'Outpatient care management (procedure)' }`
  - `DIAGNOSIS_TYPE_CODING` (S5 `ndhm-diagnostic-type`): provisional → `148006` `Preliminary diagnosis (contextual qualifier) (qualifier value)`; primary and secondary → `89100005` `Final diagnosis (discharge) (contextual qualifier) (qualifier value)`.
  - `DOCUMENT_KIND_SUPPORTING_INFO: Record<ClaimDocumentKind, { category: string; code: string }>`, using S5 `ndhm-supportinginfo-category` / `-code`:
    - id_proof → `POI` / `PIC`; policy_card → `BVC` / `AT`; claim_form → `FCF` / `AT`; discharge_summary → `HDS` / `AT`; itemised_bill → `MB` / `FB`; investigation_reports → `DIA` / `LIR`; preauth_approval → `CIL` / `AT`; operation_notes → `CD` / `OSN`; prescription → `CD` / `DRP`; query_response → `INF` / `AT`; appeal_letter, settlement_advice, other → `OTH` / `AT`.
    - Displays are copied verbatim from the code systems.
  - `RELATIONSHIP_CODING: Record<PolicyRelationship, string>`: self → `self`, spouse → `spouse`, child → `child`, parent → `parent`, sibling → `other`, other → `other`.
- Produces (`money.ts`): `paiseToFhirMoney(p: number): { value: number; currency: 'INR' }` (`value = p / 100` with two-decimal rounding of the integer division, no float accumulation); `fhirMoneyToPaise(m: unknown): number | null` (`parseRupeesToPaise(String(m.value))` when `m.currency` is `'INR'` or absent; null otherwise or when over `MAX_DOCUMENT_PAISE`).
- Produces (`resources.ts`, pure). Every builder takes `ids: { [k: string]: string }`, which are `urn:uuid` full URLs generated by the bundle builder:
  - **`nhcxPatient(p: ClaimSnapshot['patient'], fullUrlId: string): FhirResource`**:
    - identifiers: the UHID (`type` v2-0203 `MR`, `system: uhidSystem()`, required, so the builder throws `NhcxBuildError('patient_uhid_missing')` when null) and the ABHA number when present (`type` `CS_IDENTIFIER_TYPE` `ABHA`, `system: ABHA_NUMBER_SYSTEM`, value dashed);
    - `name: [{ text }]`; `gender` mapped as SP1 does; `birthDate`;
    - **no telecom, no address, never an `ADN` identifier**;
    - `meta.profile = [PROFILE.Patient]`.
  - **`nhcxHospital(h: ClaimSnapshot['hospital']): FhirResource`**:
    - `Organization` with identifiers HFR (`PRN`) and ROHINI (`ROHINI`) for whichever are present. Neither present → `NhcxBuildError('hospital_ids_missing')`.
    - `type` `ORG_TYPE` `prov` `Healthcare Provider`; `name = h.legalName`.
  - **`nhcxPayer(ref: PayerRef): FhirResource`**: `Organization`, identifier `{ type: CS_IDENTIFIER_TYPE 'OIN' 'Other identifier', system: localSystem('payer-code'), value: String(ref.payerId) }`, `type` `ORG_TYPE` `ins` `Insurance Company` (a TPA uses `pay` `Payer`), `name`.
  - **`nhcxPractitioner(d: { name: string; registrationNumber: string | null }): FhirResource`**: identifier `{ type: { coding: [{ system: V2_0203, code: 'MD', display: 'Medical License number' }] }, value: registrationNumber }` with **no `system`**, plus `name: [{ text }]`.
    - **Ruling:** the NMC/SMC registration number is not an HPR id, so `PRACTITIONER_SYSTEM` (the HPR namespace) is not used for it (UNVERIFIED U15). `PRACTITIONER_SYSTEM` is exported for a future HPR id field (A7).
    - A null registration → `NhcxBuildError('practitioner_registration_missing')`.
  - **`nhcxLocation(h): FhirResource`**: base FHIR `Location` with `name` and `managingOrganization`.
  - **`nhcxCoverage(policy: ClaimSnapshot['policy'], refs): FhirResource`**:
    - `identifier [{ system: localSystem('policy-number'), value: policyNumber }]`, `status: 'active'`, `type` `ACT_CODE` `HIP` `health insurance plan policy`;
    - `subscriber`/`beneficiary` → Patient; `subscriberId: memberId`; `relationship` from `RELATIONSHIP_CODING`;
    - `payor` → the insurer Organization; `period { start: validFrom, end: validTo }`.
  - `class NhcxBuildError extends Error { constructor(public code: NhcxBuildErrorCode) }`. `NHCX_BUILD_ERROR_COPY`:
    - `patient_uhid_missing: 'The patient has no UHID'`
    - `hospital_ids_missing: 'Set the hospital HFR or ROHINI ID in RCM settings'`
    - `practitioner_registration_missing: 'The treating doctor has no registration number'`
    - `sample_codes: 'Sample code sets cannot be sent to an insurer; load the licensed code set and re-code'`
    - `unmapped_procedure_codes: 'A procedure code has no NHCX code system (package codes); submit through the portal'`
    - `no_items: 'The claim has no items'`
    - `no_diagnosis: 'Add at least one coded diagnosis'`
    - `payer_not_on_nhcx: 'This insurer or TPA has no NHCX participant code'`
    - `attachments_too_large: 'The attached documents are too large for NHCX; submit through the portal'`
- Produces (`eligibility.ts`):
  - **`buildEligibilityBundle(i: { requestId: string; purpose: EligibilityPurpose; created: Date; patient; hospital; insurer: PayerRef; policy; practitioner; serviceDate: string }): FhirBundle`**:
    - `Bundle { resourceType, id, meta.profile [PROFILE.CoverageEligibilityRequestBundle], identifier: { value: requestId }, type: 'collection', timestamp: istIsoWithOffset(created), entry }`.
    - The entry order matches S5 examples: CoverageEligibilityRequest, Patient, Practitioner, Organization (insurer), Organization (hospital), Location, Coverage, each with `fullUrl: 'urn:uuid:<uuid>'`.
    - The CoverageEligibilityRequest has: `identifier [{ system: localSystem('eligibility'), value: requestId }]`, `status 'active'`, `priority` `normal`, `purpose [purpose]`, `patient`, `servicedDate`, `created`, `enterer` and `provider` → Practitioner, `insurer`, `facility` → Location, `insurance [{ focal: true, coverage }]`.
  - **`parseEligibilityResponse(bundle: unknown): { ok: true; summary: NhcxResponseSummary; requestIdentifier: string | null } | { ok: false; problem: string }`**:
    - finds the `CoverageEligibilityResponse` entry;
    - `inforce` = `insurance[0].inforce ?? null`; `outcome`; `errorCodes` from `error[].code.coding[].code`;
    - `disposition` is not copied into the summary.
- Produces (`validate.ts`):
  - `REQUIRED_PATHS: Record<'Claim' | 'CoverageEligibilityRequest' | 'Coverage' | 'Patient' | 'Organization' | 'Practitioner' | 'Communication' | 'PaymentNotice' | 'Task' | 'Bundle', string[]>`. It is copied from the S5 6.5.0 snapshot minimums (Claim: `identifier status type use patient created insurer provider priority diagnosis insurance item`, …). The file header comment names the package version.
  - `validateNhcxBundle(bundle: unknown, profile: 'ClaimBundle' | 'CoverageEligibilityRequestBundle' | 'TaskBundle'): string[]`. It returns human-readable problems, e.g. `'Claim.diagnosis is required'`, and checks:
    1. `type === 'collection'`, `identifier.value`, `timestamp`;
    2. the profile's required first entry (ClaimBundle: ≥1 Claim; CoverageEligibilityRequestBundle: exactly 1 CoverageEligibilityRequest; TaskBundle: exactly 1 Task);
    3. every resource's `REQUIRED_PATHS`;
    4. every `reference` resolves to a `fullUrl` in the bundle;
    5. every coding has `system` and `code` where S5 makes them required (Claim `item.productOrService.coding`, `diagnosis.type.coding`, `supportingInfo.category.coding` and `.code.coding`);
    6. **no identifier anywhere with type code `ADN` or system containing `uidai`**.
  - An optional HAPI validator CI step is described in Execution notes; it is not a dependency.

- [ ] **Step 1: Write the failing tests**

```ts
// validate.test.ts — conformance against the official examples
it.each(['Bundle-CoverageEligibilityRequestBundle-validation-example-01', 'Bundle-ClaimBundle-preauthorization-example-01', 'Bundle-ClaimBundle-settlement-example-01', 'Bundle-TaskBundleForCommunicationRequest-example-01'])('the de-identified official example %s validates', (n) => {
  const profile = n.includes('Claim') ? 'ClaimBundle' : n.includes('Task') ? 'TaskBundle' : 'CoverageEligibilityRequestBundle'
  expect(validateNhcxBundle(fixture(n), profile)).toEqual([])
})
it('reports a missing required element and a dangling reference', () => {
  const b = clone(fixture('Bundle-ClaimBundle-preauthorization-example-01')); delete b.entry[0].resource.diagnosis; b.entry[0].resource.patient.reference = 'urn:uuid:nope'
  expect(validateNhcxBundle(b, 'ClaimBundle')).toEqual(expect.arrayContaining(['Claim.diagnosis is required', 'Claim.patient references urn:uuid:nope, which is not in the bundle']))
})
it('refuses any Aadhaar identifier', () => { const b = withIdentifier(fixture(...), { type: { coding: [{ system: CS_IDENTIFIER_TYPE, code: 'ADN' }] }, value: 'x' }); expect(validateNhcxBundle(b, 'ClaimBundle')).toContain('Aadhaar identifiers must never be sent') })
it('fixtures carry no Aadhaar after de-identification', () => { for (const f of allFixtures()) expect(JSON.stringify(f)).not.toMatch(/uidai|"ADN"|\b\d{12}\b/) })
// resources.test.ts
it('the patient has UHID and ABHA identifiers, no telecom, address or ADN', () => {
  const p = nhcxPatient({ ...PATIENT, abhaNumber: '91-1234-5678-9012' }, 'u1')
  expect(p.identifier.map((i: any) => i.type.coding[0].code)).toEqual(['MR', 'ABHA']); expect(p.identifier[1].system).toBe('https://healthid.ndhm.gov.in')
  expect(p).not.toHaveProperty('telecom'); expect(p).not.toHaveProperty('address')
})
it('the hospital needs HFR or ROHINI', () => { expect(() => nhcxHospital({ ...HOSPITAL, hfrId: null, rohiniId: null })).toThrow(NhcxBuildError) })
it('a doctor without a registration number cannot be sent', () => {})
it('money converts without float drift', () => { expect(paiseToFhirMoney(123_456_789)).toEqual({ value: 1234567.89, currency: 'INR' }); expect(fhirMoneyToPaise({ value: 1234567.89, currency: 'INR' })).toBe(123_456_789); expect(fhirMoneyToPaise({ value: 1.234 })).toBeNull() })
// eligibility.test.ts
it('builds a valid eligibility bundle', () => { expect(validateNhcxBundle(buildEligibilityBundle(INPUT), 'CoverageEligibilityRequestBundle')).toEqual([]) })
it('parses the official validation response as in force', () => { expect(parseEligibilityResponse(fixture('Bundle-CoverageEligibilityResponseBundle-validation-example-01'))).toMatchObject({ ok: true, summary: { inforce: true, outcome: 'complete' } }) })
// patient-mapping.test.ts (update): ABHA number system https://healthid.ndhm.gov.in; ABHA address has no system
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/fhir` → FAIL.
- [ ] **Step 3: Download and de-identify the fixtures, then implement.**
- [ ] **Step 4: Verify:** `npx vitest run tests/lib/fhir tests/lib/no-aadhaar-leak.test.ts`, plus `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/fhir tests/lib/fhir tests/fixtures/nhcx
git commit -m "feat(sp8): NRCeS 6.5.0 base resources, eligibility bundle, structural validator and verified ABHA identifier system"
```

---

### Task 10: Claim (pre-auth and claim) bundles, response parsers, Communication and PaymentNotice TaskBundles

**Files:**
- Create: `src/lib/fhir/nhcx/claim.ts`, `src/lib/fhir/nhcx/responses.ts`
- Test: `tests/lib/fhir/nhcx/claim.test.ts`, `tests/lib/fhir/nhcx/responses.test.ts`

**Interfaces:**
- Consumes: Task 9; SP7 `ClaimSnapshot`, `PreauthSnapshot`, `CodedEntry`, `SnapshotItem`, `SnapshotDocument`.
- Produces (`claim.ts`):
  - `interface ClaimBundleContext { created: Date; practitioner: { name: string; registrationNumber: string | null }; attachments?: Map<string /* sha256 */, { contentType: string; dataBase64: string }>; priorPreauthRef?: string | null }`
  - **`buildClaimBundle(s: ClaimSnapshot, ctx: ClaimBundleContext): FhirBundle`**:
    - `Claim.use = 'claim'`.
    - `identifier [{ type: CS_IDENTIFIER_TYPE 'CLN' 'Claim number', system: localSystem('claim-number'), value: \`${claimNumber}/v${version}\` }]`; `status 'active'`; `type = CLAIM_TYPE_CODING[claimType]`; `priority` `normal`; `created`.
    - `billablePeriod { start: episode.startDate, end: episode.endDate }`.
    - `careTeam [{ sequence: 1, provider → Practitioner, role: SNOMED 223366009 'Healthcare professional (occupation)', qualification: SNOMED 394658006 'Clinical specialty (qualifier value)' }]` (values from the S5 preauthorization example).
    - `diagnosis`: one per `s.diagnoses` with `sequence`, `diagnosisCodeableConcept.coding [{ system: fhirSystemFor({ kind, version, isSample: isSampleVersion(version) }), version, code, display }]` and `type [DIAGNOSIS_TYPE_CODING[type]]`.
    - `procedure`: one per `s.procedures` with `date: performedOn`.
    - `insurance [{ sequence: 1, focal: true, coverage, preAuthRef: approvalReference ? [approvalReference] : undefined }]`.
    - `item`: one per `s.items` with `sequence`, `careTeamSequence [1]`, `productOrService.coding [{ system: localSystem('service-code'), code: itemCode, display: itemName }]`, `servicedDate`, `quantity { value }`, `unitPrice: paiseToFhirMoney(unitPricePaise)`, `net: paiseToFhirMoney(totalPaise)` (tax included; ruling 9).
    - `supportingInfo`: one per non-waived document, using `DOCUMENT_KIND_SUPPORTING_INFO`, with `valueAttachment { contentType, title, data? }`. `data` is set only when `ctx.attachments` has the sha256; otherwise the attachment carries `title` only, which is what the in-transaction validation uses.
    - `total: paiseToFhirMoney(totals.claimedPaise)`.
    - `related` is **not set** on claim bundles in SP8, including resubmissions and appeals: the `ndhm-related-claim-relationship-code` value for a resubmission is unverified (U15). Query responses go out as Communication TaskBundles, not as Claims.
  - **`buildPreauthBundle(s: PreauthSnapshot, ctx): FhirBundle`**:
    - `Claim.use = 'preauthorization'`; `identifier` value `preauthNumber`.
    - `item` from `estimate` (`productOrService` local service code, `unitPrice`, `net = amountPaise`); `total = requestedPaise`.
    - `kind = 'enhancement'` adds `insurance[0].preAuthRef = [ctx.priorPreauthRef]` when given, plus `related [{ relationship: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/ex-relatedclaimrelationship', code: 'prior', display: 'Prior Claim' }] } }]` (S5 enhancement example).
    - The diagnoses carry `type` provisional (148006).
  - **`claimBundleProblems(s: ClaimSnapshot | PreauthSnapshot, ctx): NhcxBuildErrorCode[]`**: the pre-send gate, in order:
    1. `no_items`;
    2. `no_diagnosis` (pre-auth: no coded diagnosis and only provisional text → `no_diagnosis`, because S5 requires a coded `Claim.diagnosis`);
    3. `sample_codes` (any `isSampleVersion`);
    4. `unmapped_procedure_codes` (any procedure whose `fhirSystemFor` is null, e.g. `hbp`; U15);
    5. `practitioner_registration_missing`;
    6. `hospital_ids_missing`;
    7. `patient_uhid_missing`.

    After that, `validateNhcxBundle` must return `[]`.
- Produces (`responses.ts`):
  - **`parseClaimResponseBundle(bundle: unknown): { ok: true; summary: NhcxResponseSummary; claimIdentifier: string | null; preAuthRef: string | null; dispositionText: string | null } | { ok: false; problem: string }`**:
    - `outcome`, `use`, `preAuthRefPresent`;
    - `submittedPaise` from `total[]` with category `submitted`;
    - `benefitPaise` from category `benefit` (the S5 settlement example uses `eligpercent` with an amount; that is **not** read as approved; UNVERIFIED which category NHCX payers use);
    - `adjudicationReasonCodes` from any `item[].adjudication[].reason.coding[]` with system `CS_ADJUDICATION_REASON`;
    - `errorCodes`.
    - `preAuthRef` and `dispositionText` are returned for the encrypted payload view only, not for the summary.
  - **`parseCommunicationRequestTaskBundle(bundle)`** → `{ ok: true; basedOnIdentifier: string | null; text: string; requestIdentifier: string | null }`, the S5 `TaskBundleForCommunicationRequest` shape (Task `poll`, input `include` → CommunicationRequest `payload[].contentString`).
  - **`buildCommunicationResponseTaskBundle(i: { request: { identifier: string; fullBundle: unknown }; text: string; attachments: { contentType: string; title: string; dataBase64?: string }[]; created: Date; hospital; payer }): FhirBundle`**: the S5 `TaskBundleForCommunicationResponse` shape:
    - Task `status 'completed'`, `intent 'order'`, `code` `CS_TASK_CODES` `deliver`, input `include` → Communication;
    - Communication `status 'completed'`, `category` `notification`, `basedOn` → the echoed CommunicationRequest, `payload` text plus attachments.
  - **`parsePaymentNoticeTaskBundle(bundle)`** → `{ ok: true; summary: { paymentAmountPaise, paymentDate }; paymentIdentifier: string | null }`.
  - **`buildPaymentAckTaskBundle(i: { created: Date; hospital; payer }): FhirBundle`**: the S5 `TaskBundleForPaymentNoticeResponse` shape, Task `completed`, `code` `FINANCIAL_TASK_CODE` `status`, output `CS_TASK_OUTPUT_TYPE` `status` → `CS_TASK_OUTPUT_VALUE` `paymentack` `Payment is acknowledged`.

- [ ] **Step 1: Write the failing tests**

```ts
// claim.test.ts (SNAP = SP7 ClaimSnapshot fixture with licensed ICD-10 version '2019')
it('builds a claim bundle that validates and carries the snapshot totals', () => {
  const b = buildClaimBundle(SNAP, CTX); expect(validateNhcxBundle(b, 'ClaimBundle')).toEqual([])
  const claim = b.entry[0].resource; expect(claim.use).toBe('claim'); expect(claim.total).toEqual(paiseToFhirMoney(SNAP.totals.claimedPaise))
  expect(claim.item).toHaveLength(SNAP.items.length); expect(claim.type.coding[0].code).toBe('737481003')
  expect(claim.diagnosis[0].diagnosisCodeableConcept.coding[0]).toMatchObject({ system: 'http://hl7.org/fhir/sid/icd-10', version: '2019' })
})
it('a pre-auth enhancement references the prior approval', () => { const c = buildPreauthBundle({ ...PRE, kind: 'enhancement' }, { ...CTX, priorPreauthRef: 'PA123' }).entry[0].resource; expect(c.use).toBe('preauthorization'); expect(c.insurance[0].preAuthRef).toEqual(['PA123']) })
it('refuses a bundle with sample-set codes', () => { expect(claimBundleProblems({ ...SNAP, diagnoses: [{ ...SNAP.diagnoses[0], version: 'SAMPLE-ICD10-0' }] }, CTX)).toEqual(['sample_codes']) })
it('refuses when the treating doctor has no registration number', () => { expect(claimBundleProblems(SNAP, { ...CTX, practitioner: { name: 'Dr A', registrationNumber: null } })).toEqual(['practitioner_registration_missing']) })
it('refuses package (hbp) procedure codes', () => {})
it('maps document kinds to S5 supporting-info codes and embeds data only when given', () => {})
it('the bundle carries no phone, email, address or ADN', () => { expect(JSON.stringify(buildClaimBundle(SNAP, CTX))).not.toMatch(/telecom|"address"|"ADN"|uidai/) })
// responses.test.ts
it('parses the official pre-auth response without treating eligpercent as approval', () => {
  expect(parseClaimResponseBundle(fixture('Bundle-ClaimResponseBundle-settlement-example-01'))).toMatchObject({ ok: true, summary: { outcome: 'complete', use: 'claim', submittedPaise: 90_000_00, benefitPaise: null } })
})
it('reads a communication request and builds a response that validates', () => {
  const r = parseCommunicationRequestTaskBundle(fixture('Bundle-TaskBundleForCommunicationRequest-example-01')); expect(r).toMatchObject({ ok: true, text: expect.stringMatching(/Angeography report/) })
  expect(validateNhcxBundle(buildCommunicationResponseTaskBundle(RESP), 'TaskBundle')).toEqual([])
})
it('reads a payment notice and builds the paymentack', () => {
  expect(parsePaymentNoticeTaskBundle(fixture('Bundle-TaskBundleForPaymentNoticeRequest-example-01'))).toMatchObject({ ok: true, summary: { paymentAmountPaise: 1_80_000_00, paymentDate: '2025-03-07' } })
  expect(buildPaymentAckTaskBundle(ACK).entry[0].resource.output[0].valueCodeableConcept.coding[0].code).toBe('paymentack')
})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/fhir/nhcx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same command, plus `npx vitest run tests/lib/no-aadhaar-leak.test.ts`, plus `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/fhir/nhcx tests/lib/fhir/nhcx
git commit -m "feat(sp8): NHCX claim and pre-auth bundles from SP7 snapshots, response parsers and communication/payment TaskBundles"
```

---

### Task 11: `NhcxClaimGateway`, transactional outbox, post-commit dispatch, pre-auth send

**Files:**
- Create: `src/lib/nhcx/claim-gateway.ts`, `src/lib/nhcx/mock-transport.ts`, `src/lib/queries/nhcx-exchanges.ts`, `src/app/api/rcm/preauths/[id]/nhcx/route.ts`
- Modify (`// SP8` blocks):
  - `src/lib/queries/claim-submissions.ts`:
    - `defaultSubmissionDeps.gateway = (c) => getClaimGateway(c, { nhcx: resolveNhcxClaimGateway() })`;
    - in step 4 of `submitClaimVersion`, after the `claim_dispatches` insert and only when `result.transport === 'nhcx'`, call `insertOutboundClaimExchange(tx, …)`;
    - after the transaction commits, `after(() => dispatchExchange(exchangeId))`. Use `after` from `next/server` only when called inside a request scope: the caller passes `deps.schedule ?? defaultSchedule`, where `defaultSchedule` wraps `after` in a try/catch that falls back to `void fn()`.
  - `src/lib/blob-store.ts`: `getPrivateBlobBytes(url: string): Promise<Uint8Array | null>`, only if SP5 did not export it.
  - `tests/api/rbac-route-gates.test.ts`.
- Test: `tests/lib/nhcx/claim-gateway.test.ts`, `tests/lib/queries/nhcx-exchanges.test.ts` (DB), `tests/api/rcm-preauth-nhcx.test.ts`

**Interfaces:**
- Consumes: Tasks 7–10; SP7 `ClaimGateway`, `SubmissionPackage`, `GatewaySubmitResult`, `nhcxGatewayStub`, `getClaimGateway`, `lockPatientBilling`, `RCM_ERROR_MESSAGE`; SP5 blob bytes.
- Produces (`claim-gateway.ts`):
  - `nhcxClaimGateway(deps: { config: () => ReturnType<typeof readNhcxConfig>; loadContext: (pkg: SubmissionPackage) => Promise<ClaimBundleContext & { recipientCode: string | null }> }): ClaimGateway`:
    - `channel: 'nhcx'`.
    - `status()` → `{ configured: true, label: 'NHCX connected' }` or `{ configured: true, label: 'NHCX sandbox mock - not real' }`. When not configured, `resolveNhcxClaimGateway` returns the SP7 stub instead.
    - `submit(pkg)` is pure apart from `loadContext` (a DB read through `getDb()`, not the caller's transaction; acceptable because the submission transaction rebuilds and compares the snapshot hash). It checks:
      1. `recipientCode === null` → `{ ok: false, error: 'rejected', message: NHCX_BUILD_ERROR_COPY.payer_not_on_nhcx }`;
      2. `claimBundleProblems(pkg.snapshot, ctx)` non-empty → `rejected` with the first problem's copy;
      3. `validateNhcxBundle(buildClaimBundle(pkg.snapshot, ctx), 'ClaimBundle')` non-empty → `rejected` with `'The claim could not be prepared for NHCX'` (the problems go to `safeLog` as a count only);
      4. otherwise `{ ok: true, transport: 'nhcx', trackingReference: correlationId }`, where `correlationId = randomUUID()`. **No network call.**
  - `resolveNhcxClaimGateway(env?): ClaimGateway`: configured or mock → `nhcxClaimGateway(...)`; else `nhcxGatewayStub`.
  - `recipientCodeFor(policy: { insurer: PayerRef; tpa: PayerRef | null }): string | null`: TPA code when the TPA has one, else the insurer code. S3 says to address the policy's processing entity, the TPA (ruling 8).
- Produces (`nhcx-exchanges.ts`):
  - `insertOutboundClaimExchange(tx: WriteExecutor, i: { claimId: number; claimSubmissionId: number; patientId: string; correlationId: string; kind: SubmissionKind; rcmQueryId: number | null; recipientCode: string; isMock: boolean; bodySha256: string }): Promise<{ exchangeId: number }>`:
    - `entityType 'claim'`, `action`: `communication/on_request` when `kind === 'query_response'` (the correlation id is then the inbound communication exchange's, looked up by `rcmQueryId`), else `claim/submit`;
    - `state 'pending_send'`, `apiCallId = randomUUID()`, `nextAttemptAt = now`.
  - `createPreauthExchange(preauthId: number, session: Session, deps?): Promise<RcmWriteResult<{ exchangeId: number; correlationId: string }>>`:
    - **Status rules:** the pre-auth must be `requested` or `enhancement_requested`, with a latest `request`/`request_enhancement` event that has a snapshot → else `invalid_transition`. An outbound exchange already on that event → `duplicate_reference` ("Already sent through NHCX").
    - **Checks:** `recipientCodeFor`, `claimBundleProblems` and validation, each mapped to `rejected` copy in a 422.
    - **Write:** `lockPatientBilling`, then the pre-auth `FOR UPDATE`, then the insert (`entityType 'preauth'`, `action 'preauth/submit'`, `preauthEventId`). Then `after(dispatch)`.
    - **Audit:** `nhcx: queued pre-authorisation`, details `preauth=<id> exchange=<id> corr=<first 8>`.
  - `dispatchExchange(exchangeId: number, deps?: { now?: () => Date; client?: typeof postSealed; certs?: typeof getRecipientCert; blobs?: (url: string) => Promise<Uint8Array | null>; mock?: MockTransport }): Promise<'sent' | 'retry' | 'failed' | 'skipped'>`. Never called inside a transaction.
    - **Claim step:** `select … for update skip locked` on the exchange row with `state in ('pending_send')` and `nextAttemptAt <= now`, in a short transaction that bumps `attempts` and sets `nextAttemptAt` = now + 5 min (a lease). Otherwise `'skipped'`.
    - **Build and seal:** when `jweEncrypted` is null, rebuild the FHIR from the immutable snapshot (`claim_submissions.snapshot` / `preauth_events.snapshot`). Load the attachments via `claim_documents` (live, by sha256, ≤ `maxAttachmentBytes` in total, else mark `send_failed` with `lastErrorCode 'attachments_too_large'`). Then `getRecipientCert`, `buildRequestHeaders({ correlationId, apiCallId: row.apiCallId … })`, `sealHcxPayload`, and store `jweEncrypted = vault(jwe)` plus `bodySha256` in a short transaction. Otherwise reuse the stored JWE.
    - **Send:** `postSealed`.
    - **Outcome:**
      - `accepted` → `state 'sent'`, `jweEncrypted = null`, `nextAttemptAt = null`, `protocolStatus 'request.queued'`.
      - `rejected` → `state 'send_failed'`, `lastErrorCode`, `jweEncrypted = null`. The SP7 claim gets a `claim_events` `note` row (`byName 'NHCX gateway'`, note `NHCX refused the submission (<code>); send it through another channel`); the pre-auth case writes no event and shows it on the exchange panel.
      - `retryable` → `nextAttemptAt = nextAttemptAt(attempts)`; when that is null → `send_failed` with `lastErrorCode 'max_attempts'`.
    - **Audit:** `logGatewayEvent('NHCX gateway', 'nhcx: dispatched exchange' | 'nhcx: exchange send failed', patientId, 'exchange=<id> outcome=<o> attempt=<n>')`.
    - **Mock:** `isMock` rows go to `mockTransport.send(row)` instead (Task 12 consumes it).
  - `type MockTransport = { send(row: NhcxExchangeRow, fhir: object): Promise<void> }`; `mockTransport` (in `mock-transport.ts`) accepts and, through `after`, feeds a synthesised response into `processInboundFhir` (Task 12) with `isMock: true`:
    - eligibility → `inforce: true`;
    - pre-auth → ClaimResponse `outcome 'queued'`;
    - claim → `queued`.
    - It never fabricates an approval amount.
  - `listExchangesFor(subject: { claimId?: number; preauthId?: number; patientId?: string }): Promise<ExchangeView[]>`: `{ id, entityType, action, direction, state, protocolStatus, correlationPrefix, attempts, lastErrorCode, createdAt, respondedAt, reviewState, summary, isMock }`. No payloads, no JWE.
- **Route `POST /api/rcm/preauths/[id]/nhcx`:** gate `NHCX_EXCHANGE_ROLES`; empty body (`{}` strict); not configured → 503 `NHCX is not configured`; errors via SP7 `rcmErrorResponse`; 202 `{ exchangeId, correlationPrefix }`.

- [ ] **Step 1: Write the failing tests**

```ts
// claim-gateway.test.ts
it('not configured resolves to the SP7 stub', () => { expect(resolveNhcxClaimGateway({})).toBe(nhcxGatewayStub) })
it('submit validates and returns a correlation id without any network call', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch'); const r = await gw.submit(PKG)
  expect(r).toMatchObject({ ok: true, transport: 'nhcx', trackingReference: expect.stringMatching(UUID) }); expect(fetchSpy).not.toHaveBeenCalled()
})
it('a payer without a participant code is rejected with the copy', async () => {})
it('NHCX refusal leaves the manual channel usable', async () => { /* rejected for sample codes; getClaimGateway('portal').submit(PKG) ok */ })
it('the recipient is the TPA when it has a code', () => {})
// nhcx-exchanges.test.ts (DB, SP7 fixtures through a ready claim; client and certs injected)
it('the outbox row commits with the claim version and nothing is sent inside the transaction', async () => {
  /* submitClaimVersion(channel nhcx) with deps.schedule capturing fn; inside the tx assert client not called; after commit one exchange 'pending_send'; claim_dispatches.trackingReference === exchange.correlationId */
})
it('dispatch sends once, stores state sent and drops the stored JWE', async () => {})
it('a failed send is retried with the same api_call_id', async () => {
  /* client: retryable then accepted; both calls received identical compact JWE; exchange.apiCallId unchanged; attempts 2 */
})
it('after five retryable failures the exchange is send_failed and the claim gets a note event', async () => {})
it('concurrent submits create one exchange', async () => { /* two submitClaimVersion → one version, one exchange (nhcx_exchanges_submission_unique) */ })
it('concurrent dispatches of one exchange send once', async () => { /* skip locked lease */ })
it('a query response goes out as communication/on_request on the insurer correlation id', async () => {})
it('attachments over the cap fail with attachments_too_large and never call the client', async () => {})
// rcm-preauth-nhcx.test.ts
it('frontdesk/billing/coder get 403 before the body; 503 when unconfigured; 202 when queued', async () => {})
it('sending the same request event twice is refused', async () => {})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/nhcx/claim-gateway.test.ts tests/api/rcm-preauth-nhcx.test.ts`, `npm test -- tests/lib/queries/nhcx-exchanges.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Add the harness rows.
- [ ] **Step 4: Verify:** same commands, plus `npm test -- tests/lib/queries/claim-submissions.test.ts tests/api/rbac-route-gates.test.ts` (SP7 stays green), plus `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/nhcx src/lib/queries/nhcx-exchanges.ts src/lib/queries/claim-submissions.ts src/lib/blob-store.ts src/app/api/rcm/preauths tests
git commit -m "feat(sp8): NhcxClaimGateway with transactional outbox, post-commit dispatch, same-id retries and pre-auth send"
```

---

### Task 12: NHCX callback receiver — security pipeline, replay dedupe, inbound handlers

**Files:**
- Create: `src/lib/nhcx/callback-auth.ts`, `src/lib/nhcx/inbound.ts`, `src/app/api/nhcx/callback/[...action]/route.ts`
- Modify: `src/lib/rate-limit.ts` (`checkNhcxCallbackRateLimit(ip)`)
- Test: `tests/lib/nhcx/callback-auth.test.ts`, `tests/lib/nhcx/inbound.test.ts` (DB), `tests/api/nhcx-callback.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 7, 9, 10; SP7 `claim_events`, `lockPatientBilling`.
- **Route path.** NHCX calls `endpoint_url` plus the action path; whether it adds the `/v1` prefix is UNVERIFIED U7. The catch-all accepts `[...action]` equal to an `ACCEPTED_INBOUND_ACTIONS` path, optionally preceded by `v1`. Anything else → 404 `{ error: 'Not found' }`, before reading the body.
- Produces (`callback-auth.ts`):
  - `checkCallerIp(request: Request, allowlist: string[]): boolean`: true when the allowlist is empty, which `docs/ABDM-NHCX.md` documents. The NAT IPs `3.109.99.210`, `13.126.152.0` and `13.200.129.223` (S3, UNVERIFIED U6) are listed in the runbook, **not** hard-coded. Otherwise the first `x-forwarded-for` hop must be in the list.
  - `verifyNhcxBearer(request: Request, signingCertPem: string | null, now?: Date): Promise<boolean>`: `Authorization: Bearer <jwt>` verified with `jwtVerify(jwt, await importX509(signingCertPem, 'RS256'), { algorithms: ['RS256'], clockTolerance: 60 })`. S3 says "NHCX signs its calls to you with its own JWT, using RS256"; where the key comes from is UNVERIFIED U6, and the operator supplies it as `NHCX_GATEWAY_SIGNING_CERT`. A null cert means `false`, and the route then answers 503.
- Produces (`inbound.ts`):
  - `type InboundResult = { http: 202 | 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503; body: { timestamp: string; api_call_id?: string; correlation_id?: string } | { error: string } }`
  - `handleNhcxCallback(request: Request, actionPath: string, deps?): Promise<InboundResult>`. Strict order:
    1. `readNhcxConfig()` not configured (and not mock) → 503 `{ error: 'NHCX is not configured' }`.
    2. `content-length` absent or > 2 MB → 413 `{ error: 'Payload too large' }`.
    3. `checkCallerIp` → 403 `{ error: 'Forbidden' }`.
    4. `checkNhcxCallbackRateLimit(ip)` (120 per 60 s per IP, 1000 per 60 s globally) → 429.
    5. `verifyNhcxBearer` → 401 `{ error: 'Unauthorized' }`, or 503 `{ error: 'NHCX callbacks are not configured' }` when there is no signing cert. All of this happens before the body is read.
    6. Read the text (cap enforced while streaming) and JSON-parse `{ payload }`. A plain-text `ProtocolResponse` (`type: 'ProtocolResponse'`, S3) is accepted only for `on_status`; otherwise → 400 `{ error: 'Invalid request' }`.
    7. `openHcxPayload(payload, [current, previous])` → 400 `{ error: 'Invalid request' }`.
    8. `parseProtocolHeaders` → 400. `recipient !== cfg.participantCode` → 403. `!timestampWithin(ts, now, 600)` → 400.
    9. Replay: `insert into nhcx_inbound_calls … on conflict (api_call_id) do nothing returning`. With no row, it is a replay: answer 202 with the same ids and **write nothing else**.
    10. Correlation: for `*/on_*` and `on_status`, an outbound exchange with this `correlationId` and `recipientCode === sender` must exist → else mark the inbound-call outcome `rejected` and answer 409 `{ error: 'Unknown correlation' }`. For `communication/request` and `paymentnotice/request`, the request must be about a claim or pre-auth we sent: resolve through the bundle's `basedOn` Claim identifier (`CLM-…/vN` or `PA-…`) → else 409.
    11. `processInboundFhir(...)` in one transaction.
    12. 202 `{ timestamp, api_call_id, correlation_id }` (S4 `SuccessResponse`). S3 also mentions a `result` object, UNVERIFIED U8, not sent.

    Each refusal logs `safeLog('nhcx-callback', { action, outcome, httpStatus })` only.
  - `processInboundFhir(i: { action: AcceptedInboundAction; headers: ProtocolHeaders; fhir: unknown; outbound: NhcxExchangeRow | null; isMock: boolean }, executor?): Promise<{ exchangeId: number }>`. It inserts an inbound `nhcx_exchanges` row with `direction 'inbound'`, `state 'received'`, `relatedExchangeId = outbound.id`, `payloadEncrypted = vault(JSON)`, `bodySha256`, `summary`, `protocolStatus`, `isMock`, and updates the outbound row (`state 'responded'`, or `'error'` on `response.error`; `respondedAt`). Per action:
    - **`coverageeligibility/on_check`**: `parseEligibilityResponse` → update `nhcx_eligibility_checks` (`status`: `inforce === true` → `eligible`, `false` → `not_eligible`, an error outcome → `error`; `inforce`; `respondedAt`). `reviewState 'not_needed'`.
    - **`preauth/on_submit`**: `parseClaimResponseBundle`; `reviewState 'pending'`. No pre-auth change.
    - **`claim/on_submit`**: same; plus, under `lockPatientBilling` and the claim `FOR UPDATE`, one `claim_events` row: `action 'note'`, `toStatus = fromStatus`, `byName 'NHCX gateway'`, `byUserId null`, note `NHCX response received (<outcome>); review it in the NHCX panel`. It also bumps `rowVersion` and `lastStatusAt`, as SP7 `note` does. Status and money are unchanged (ruling 6).
    - **`communication/request`**: `parseCommunicationRequestTaskBundle`; `entityType 'communication'`; `reviewState 'pending'`; a claim note `Insurer query received via NHCX; review it in the NHCX panel`.
    - **`paymentnotice/request`**: `parsePaymentNoticeTaskBundle`; `reviewState 'pending'`; a claim note `Payment notice received via NHCX; record the settlement after checking the bank credit`.
    - **`on_status`**: update the outbound `protocolStatus` (`request.queued` → `queued`, `request.dispatched` → `dispatched`); no inbound payload stored beyond the summary.
    - Each action ends with `logGatewayEvent('NHCX gateway', 'nhcx: received <action>', patientId, 'exchange=<id> related=<id> outcome=<summary.outcome>', tx)`.
- **Route** `src/app/api/nhcx/callback/[...action]/route.ts`: `export async function POST(request, { params })` → `handleNhcxCallback`. Every other method → 405 `{ error: 'Method not allowed' }`. `export const dynamic = 'force-dynamic'`.

- [ ] **Step 1: Write the failing tests**

```ts
// nhcx-callback.test.ts (handleNhcxCallback with injected deps; JWE built with Task 7 for our test key; bearer signed with a test RS256 key)
it('an unknown action path is a 404 before the body is read', async () => {})
it('an oversized body is refused before parsing', async () => { /* content-length 3_000_000 → 413; openHcxPayload not called */ })
it('rejects a callback whose JWT does not verify, before decrypting', async () => { /* wrong signer → 401; openHcxPayload not called; no DB write */ })
it('503 without a signing cert; 403 for an IP outside a set allowlist', async () => {})
it('a recipient code that is not ours is a 403 with no write', async () => {})
it('a stale timestamp is refused', async () => {})
it('error bodies are fixed strings', async () => { /* every refusal body ∈ the fixed set; never contains header values */ })
// inbound.test.ts (DB)
it('a replayed api_call_id is acknowledged once and written once', async () => {
  const a = await handleNhcxCallback(req(), 'claim/on_submit', D); const b = await handleNhcxCallback(req(), 'claim/on_submit', D)
  expect([a.http, b.http]).toEqual([202, 202]); expect(await countInbound()).toBe(1); expect(await countClaimNotes()).toBe(1)
})
it('an unknown correlation id is refused without a write', async () => {})
it('a ClaimResponse records a note and a pending review but leaves status and money unchanged', async () => {
  /* claim submitted claimed 1_00_000_00; on_submit with benefit total → claim.status 'submitted', approvedPaise null, settledPaise 0; one claim_events note by 'NHCX gateway'; exchange reviewState 'pending'; payload_encrypted opens to the bundle */
})
it('an eligibility response marks the check eligible', async () => {})
it('a communication request for a claim we sent is stored for review', async () => {})
it('the payload is stored encrypted and the audit row has ids only', async () => {})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/lib/nhcx/callback-auth.test.ts tests/api/nhcx-callback.test.ts`, `npm test -- tests/lib/nhcx/inbound.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** same commands, plus `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/nhcx src/lib/rate-limit.ts src/app/api/nhcx/callback tests
git commit -m "feat(sp8): NHCX callback receiver with IP, rate, JWT, JWE and header checks, replay dedupe and review-only inbound handling"
```

---

### Task 13: Status polling, cron sweep, retention purges

**Files:**
- Create: `src/app/api/rcm/nhcx/exchanges/[id]/status/route.ts` (POST), `src/app/api/cron/nhcx-sweep/route.ts` (GET)
- Modify: `src/lib/queries/nhcx-exchanges.ts`
- Test: `tests/lib/queries/nhcx-sweep.test.ts` (DB), `tests/api/nhcx-status-cron.test.ts`

**Interfaces:**
- Produces (`nhcx-exchanges.ts`):
  - `pollExchangeStatus(exchangeId: number, deps?): Promise<'sent' | 'too_soon' | 'not_pollable' | 'failed'>`:
    - pollable states are `sent`, `queued` and `dispatched`, with `lastPolledAt` older than 15 min (manual) or 6 h (sweep);
    - it builds a TaskBundle (Task `code` `FINANCIAL_TASK_CODE` `status`, `focus` the original Claim identifier) and sends it to `status` with a **new** `api_call_id` and the **original** correlation id;
    - the answer arrives on `on_status` (Task 12).
    - The `/v1/status` payload shape and the `on_status` callback are UNVERIFIED U9. The function is one place to adjust, and the sweep's polling step is skipped entirely while `NHCX_STATUS_POLLING !== '1'` (default off), so unverified traffic is never sent by default.
  - `runNhcxSweep(now: Date, deps?): Promise<{ dispatched: number; failed: number; polled: number; noResponse: number; sharesExpired: number; inboundPurged: number }>`:
    1. `dispatchExchange` for up to 25 due `pending_send` rows (ordered by `nextAttemptAt`).
    2. When polling is enabled, `pollExchangeStatus` for up to 25 rows in `sent`/`queued`/`dispatched` with `createdAt < now − 2 h`.
    3. Rows still unanswered 7 days after `createdAt` → `state 'no_response'` with a claim note `No NHCX response after 7 days; check the insurer portal`.
    4. `expireShares(now)` (Task 6).
    5. Delete `nhcx_inbound_calls` older than 30 days under `hims.allow_document_purge` (ruling 4). ABHA flow entries in Redis need no sweep; they expire by TTL.

    Logs `safeLog('nhcx-sweep', counts)`.
- **Routes:**
  - `POST /api/rcm/nhcx/exchanges/[id]/status`: gate `NHCX_EXCHANGE_ROLES`; empty strict body; 503 when unconfigured; 200 `{ result }` (`too_soon` → 429 `Status was checked less than 15 minutes ago`). Audit `nhcx: requested status`, details `exchange=<id>`.
  - `GET /api/cron/nhcx-sweep`: `Authorization: Bearer <CRON_SECRET>` compared as SHA-256 digests with `timingSafeEqual`, the LIS webhook pattern. With `CRON_SECRET` unset → 503 `{ error: 'Cron is not configured' }`. A wrong token → 401 `{ error: 'Unauthorized' }`. Success → 200 with the counts. No session; listed in `SESSIONLESS_ROUTES`.

- [ ] **Step 1: Write the failing tests**

```ts
// nhcx-status-cron.test.ts
it('the cron route needs the secret and never reveals it', async () => { /* unset → 503; wrong → 401; right → 200 counts */ })
it('status check is gated, rate limited per exchange and 503 when unconfigured', async () => {})
// nhcx-sweep.test.ts (DB)
it('the sweep dispatches due rows, leaves leased rows, and marks 7-day silence as no_response with a note', async () => {})
it('status polling is off by default', async () => { /* NHCX_STATUS_POLLING unset → polled 0, client not called */ })
it('inbound call rows older than 30 days are purged; newer ones stay', async () => {})
it('pending shares older than 24 h are expired and scrubbed', async () => {})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/api/nhcx-status-cron.test.ts`, `npm test -- tests/lib/queries/nhcx-sweep.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Add the harness rows for the status route, and add `NHCX_STATUS_POLLING=` to `.env.example` and the runbook.
- [ ] **Step 4: Verify:** same commands, plus `npm test -- tests/api/rbac-route-gates.test.ts`, plus `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/nhcx-exchanges.ts src/app/api/rcm/nhcx src/app/api/cron .env.example docs/ABDM-NHCX.md tests
git commit -m "feat(sp8): NHCX status polling behind a flag, cron sweep for retries, silence and retention purges"
```

---

### Task 14: NHCX eligibility check replacing the simulated one

**Files:**
- Create: `src/lib/queries/nhcx-eligibility.ts`, `src/app/api/nhcx/eligibility/route.ts` (POST), `src/app/api/nhcx/eligibility/[id]/route.ts` (GET), `src/components/nhcx/EligibilityCheckPanel.tsx`
- Modify:
  - `src/components/rcm/PatientPoliciesPanel.tsx` (SP7): a "Check eligibility (NHCX)" action per active policy for `NHCX_ELIGIBILITY_ROLES`, with `context` `registration` from the registration success page or `manual` from the patient page.
  - The admission form (`src/components/inpatient/AdmitPatientForm.tsx` or the SP3 admission entry; find it with `grep -rln "admitPatient" src/components`): the same panel with `context 'admission'`.
  - The SP7 pre-auth detail page: the panel with `context 'preauth'` and `purpose 'auth-requirements'`.
  - `src/app/api/front-desk/eligibility-check/route.ts`: after the role gate, return 410 `{ error: 'Simulated eligibility checks are retired; use the NHCX eligibility check on the patient\'s policy' }`.
  - `src/app/(dashboard)/billing/page.tsx`: remove `EligibilityCheckButton` (the component files stay unused; Task 16 deletes them after checking for no imports).
  - `tests/api/front-desk-eligibility-check.test.ts`, `tests/components/EligibilityCheckModal.test.tsx` (update or remove with the component), `tests/api/rbac-route-gates.test.ts`.
- Test: `tests/lib/queries/nhcx-eligibility.test.ts` (DB), `tests/api/nhcx-eligibility.test.ts`, `tests/components/nhcx/EligibilityCheckPanel.test.tsx`

**Interfaces:**
- Produces (`nhcx-eligibility.ts`):
  - `requestEligibility(input: { policyId: number; purpose: EligibilityPurpose; context: EligibilityContext; providerId: number }, session: Session, now?: Date): Promise<RcmWriteResult<{ checkId: number; exchangeId: number }>>`. It checks, in order:
    1. the policy is active and in its validity window on `todayIsoIn(IST)` (`policy_not_found` / `payer_inactive`);
    2. `recipientCodeFor` is non-null → else `gateway_not_configured` with message `NHCX_BUILD_ERROR_COPY.payer_not_on_nhcx`;
    3. the provider has a registration number (`practitioner_registration_missing` copy, 422);
    4. hospital ids exist.

    Then:
    - **Insert:** in one transaction, insert the check (`pending`, `isMock` from config) and an outbound exchange (`coverageeligibility/check`, `eligibilityCheckId`, `policyId`, `bodySha256` of the built bundle).
    - **Dispatch:** `after(dispatchExchange)`.
    - **Bundle sources:** `buildEligibilityBundle`, with Patient from the RCM minimum (`includeAbha` when the payer `requiresAbha`) and Coverage from the policy.
    - **Audit:** `nhcx: requested eligibility`, details `check=<id> policy=<id> purpose=<p> context=<c>`.
  - `getEligibilityCheck(id: number): Promise<{ id: number; status: EligibilityStatus; inforce: boolean | null; requestedAt: Date; respondedAt: Date | null; payerName: string; isMock: boolean } | null>`.
  - `latestEligibilityForPolicy(policyId: number): Promise<…same | null>`.
- **Routes:**
  - `POST /api/nhcx/eligibility`: `NHCX_ELIGIBILITY_ROLES`; body `{ policyId: positive int, purpose (default 'validation'), context, providerId: positive int }` strict; 503 `NHCX is not configured`; 202 `{ checkId }`.
  - `GET /api/nhcx/eligibility/[id]`: same gate; 200 the view.
- **`EligibilityCheckPanel({ policyId, context, purpose, providers, defaultProviderId, nhcxConfigured, payerOnNhcx })`:**
  - When NHCX is not configured: the disabled button `Check eligibility (NHCX)` with the text `NHCX not configured`.
  - When the payer is not on NHCX: `This insurer is not on NHCX; confirm cover through the insurer portal`.
  - Otherwise it posts, then polls `GET` every 5 s for up to 2 minutes, then shows `Waiting for the insurer; check again later`.
  - Results: `Policy in force` (green), `Policy not in force` (red), `The insurer returned an error`, plus `Sandbox mock - not real` for mock rows.

- [ ] **Step 1: Write the failing tests**

```ts
// nhcx-eligibility.test.ts (DB)
it('creates a pending check and an outbound exchange in one transaction', async () => {})
it('a payer without a participant code is refused with the copy and stores nothing', async () => {})
it('an expired policy is refused', async () => {})
it('the eligibility bundle carries ABHA only when the payer requires it', async () => {})
// nhcx-eligibility.test.ts (route)
it('pharmacy, labs, coder, pi get 403 before the body; 503 when unconfigured; 202 queued', async () => {})
// legacy
it('the simulated eligibility route is retired with 410 for allowed roles and 403 for others', async () => {})
// EligibilityCheckPanel.test.tsx
it('shows not configured, not on NHCX, waiting, in force and mock states', async () => {})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/api/nhcx-eligibility.test.ts tests/components/nhcx tests/api/front-desk-eligibility-check.test.ts`, `npm test -- tests/lib/queries/nhcx-eligibility.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Add the harness rows (both routes in `API_GATES`, and the POST in `SP8_WRITE_GATES`).
- [ ] **Step 4: Verify:** same commands, plus `npx vitest run tests/pages tests/components/rcm`, plus `npm test -- tests/api/rbac-route-gates.test.ts`, plus `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/nhcx-eligibility.ts src/app/api/nhcx/eligibility src/app/api/front-desk/eligibility-check src/components "src/app/(dashboard)" tests
git commit -m "feat(sp8): NHCX coverage eligibility on policies, admission and pre-auth; retire the simulated check"
```

---

### Task 15: ABDM / NHCX connection settings page and the RCM NHCX panel

**Files:**
- Create:
  - `src/app/(dashboard)/settings/integrations/page.tsx`, `src/app/api/settings/integrations/test/route.ts` (POST);
  - `src/components/settings/IntegrationStatusCard.tsx`;
  - `src/components/nhcx/NhcxExchangePanel.tsx`, `src/components/nhcx/NhcxResponseReview.tsx`;
  - `src/app/api/rcm/nhcx/exchanges/[id]/review/route.ts` (POST), `src/app/api/rcm/nhcx/exchanges/[id]/payload/route.ts` (GET).
- Modify:
  - `src/app/(dashboard)/settings/page.tsx`: a link card `ABDM / NHCX connection` for admins.
  - `src/components/LeftNav.tsx` (`// SP8`: `{ href: '/settings/integrations', label: 'ABDM / NHCX', icon: Plug, roles: ['admin'] }`).
  - The SP7 claim workspace `/rcm/claims/[id]` and the pre-auth detail page: render `NhcxExchangePanel`. On the pre-auth page, add a "Send via NHCX" button, enabled for live requested statuses when the payer is on NHCX.
  - SP7 `SubmitClaimDialog`: the `nhcx` channel option is disabled with the reason from `gateway.status().label` or the payer's missing code.
  - SP7 `InsurerUpdateForms` / `SettlementPanel` / the pre-auth approve form: accept `prefill` props.
  - `tests/pages/page-gates-harness.ts`, `tests/api/rbac-route-gates.test.ts`.
- Test: `tests/pages/settings-integrations.test.tsx`, `tests/api/settings-integrations-test.test.ts`, `tests/components/nhcx/NhcxExchangePanel.test.tsx`, `tests/api/nhcx-review.test.ts`

**Interfaces:**
- **Page `/settings/integrations`** (gate `INTEGRATION_SETTINGS_ROLES`), server-rendered from `capabilityStatuses()`:
  - One `IntegrationStatusCard` per capability: state, label, missing variable **names**, and the mode (`Sandbox` when the configured ABDM base URL host is `dev.abdm.gov.in` / `abhasbx.abdm.gov.in`, else `Production`).
  - The NHCX participant code (an identifier, not a secret).
  - `certificateSummary` of `NHCX_ENCRYPTION_CERT` and `NHCX_GATEWAY_SIGNING_CERT`: subject, fingerprint prefix, valid-to, days left. An amber warning at ≤ 30 days, red when expired.
  - Whether a previous key is loaded (`Rotation in progress`).
  - Callback URL `<NEXT_PUBLIC_APP_URL>/api/nhcx/callback` and bridge URL `<NEXT_PUBLIC_APP_URL>/api/abdm`.
  - The last 10 exchanges' states (no ids beyond the exchange id).
  - **Never**: a secret, a token, a key, a client id value, or a PEM. The test renders with every secret env set and greps the HTML.
- **`POST /api/settings/integrations/test`:**
  - Gate `INTEGRATION_SETTINGS_ROLES`; body `{ capability: 'abdm' | 'nhcx' }` strict.
  - It runs a **token fetch only** (`getGatewayToken` after `resetGatewayTokenCache()`; NHCX uses the same session) and returns `{ ok: true, expiresInSeconds }` or `{ ok: false, message: ABDM_ERROR_COPY[...] }`. The mock answers `{ ok: true, mock: true }`.
  - Rate limited to 5 per minute per staff member.
  - Audit `abdm: tested connection` / `nhcx: tested connection`, details `ok=<bool>`.
- **`NhcxExchangePanel({ exchanges: ExchangeView[], canAct: boolean, subject: { claimId?: number; preauthId?: number } })`:**
  - A table of action, direction, state, attempts, last error code, created and responded times, and a mock badge.
  - For `reviewState 'pending'` rows, a "Review" button opens `NhcxResponseReview`.
- **`NhcxResponseReview`:**
  - It loads `GET …/payload` (gate `NHCX_EXCHANGE_ROLES`; decrypts server-side and returns `{ summary, dispositionText, preAuthRef, queryText, paymentAmountPaise, paymentDate }`; audit `nhcx: viewed response`, details `exchange=<id>`).
  - It offers the SP7 action matching the response, **pre-filled and not submitted**:
    - ClaimResponse on a claim → SP7 `record_decision` with `approvedPaise = benefitPaise` (empty when null);
    - `record_query` with the query text;
    - pre-auth → `approve` with the amount and `approvalReference = preAuthRef`;
    - PaymentNotice → `recordSettlement` with the amount and date (UTR typed by the user, from the bank statement).
  - On successful submit of the SP7 form, it calls `POST …/review` `{ decision: 'confirmed' }`. "Dismiss" calls `{ decision: 'dismissed', note }`.
  - After a confirmed settlement for a PaymentNotice, `…/review` with `{ decision: 'confirmed', sendPaymentAck: true }` queues an outbound `paymentnotice/on_request` exchange carrying `buildPaymentAckTaskBundle` on the inbound correlation id.
- **`POST /api/rcm/nhcx/exchanges/[id]/review`:**
  - Gate `NHCX_EXCHANGE_ROLES`; body `{ decision: 'confirmed' | 'dismissed'; note?: trim 5..500; sendPaymentAck?: boolean }` strict; only `reviewState 'pending'` (409 `Already reviewed`).
  - It sets `reviewState`, `reviewedByName` and `reviewedAt`. Audit `nhcx: reviewed response`, details `exchange=<id> decision=<d>`; the note is stored on a claim `note` event via SP7 `applyClaimUpdate({ action: 'note', … })` when the exchange has a claim.

- [ ] **Step 1: Write the failing tests**

```ts
// settings-integrations.test.tsx
it('shows states, missing names and certificate expiry, and never a secret', async () => {
  process.env.ABDM_CLIENT_SECRET = 'S3CRET-VALUE'; process.env.NHCX_ENCRYPTION_PRIVATE_KEY = b64(TEST_KEY_PEM) /* … */
  const html = await renderPage(); expect(html).not.toMatch(/S3CRET-VALUE|BEGIN|PRIVATE KEY|cid-value/); expect(html).toMatch(/days left/)
})
it('warns 30 days before certificate expiry', async () => {})
// PAGE_GATES '/settings/integrations' ['admin']
// settings-integrations-test.test.ts
it('admin-only, token fetch only, fixed messages, rate limited', async () => {})
// NhcxExchangePanel.test.tsx
it('confirming a response pre-fills the SP7 decision form and does not submit it', async () => {})
it('a pending payment notice offers a settlement form with the amount and an empty UTR', async () => {})
// nhcx-review.test.ts
it('rcm and admin only; a second review is a 409; dismiss needs a note', async () => {})
it('payload view is audited and returns no JWE or raw bundle', async () => {})
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/pages/settings-integrations.test.tsx tests/api/settings-integrations-test.test.ts tests/components/nhcx tests/api/nhcx-review.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Add the harness rows and the nav entry.
- [ ] **Step 4: Verify:** same command, plus `npx vitest run tests/pages tests/components/rcm tests/components/LeftNav.test.tsx tests/pages/nav-role-enforcement.test.tsx`, plus `npm test -- tests/api/rbac-route-gates.test.ts`, plus `npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/settings" src/app/api/settings/integrations src/app/api/rcm/nhcx src/components tests
git commit -m "feat(sp8): ABDM/NHCX connection page with cert expiry and test-connection; RCM NHCX panel with confirm-to-apply review"
```

---

### Task 16: Static leak guards, session-less route allowlist, conformance sweep, cleanup

**Files:**
- Create: `tests/lib/no-integration-secret-leak.test.ts`, `tests/api/sessionless-routes.test.ts`, `tests/lib/fhir/nhcx/conformance.test.ts`
- Modify:
  - `tests/lib/no-aadhaar-leak.test.ts`: `EXPORT_PATHS` + `'src/lib/fhir/nhcx'`, `'src/lib/nhcx'`, `'src/app/api/nhcx'`, `'src/app/api/rcm/nhcx'`, `'src/app/api/settings/integrations'`, `'src/components/nhcx'`.
  - Delete `src/components/EligibilityCheckButton.tsx` and `src/components/EligibilityCheckModal.tsx` (with their test) once `grep -rn "EligibilityCheck(Button|Modal)" src` is empty.
  - `docs/ABDM-NHCX.md`: the UNVERIFIED register (copy of this plan's list), the Phase 2 appendix summary, and the optional HAPI validation command.
- Test: the three new files.

**Interfaces:**
- `no-integration-secret-leak.test.ts` (static, same walk helpers as `no-aadhaar-leak.test.ts`). The cases:
  1. No `console.` in `src/lib/abdm`, `src/lib/nhcx`, `src/lib/fhir/nhcx`, `src/lib/integrations` (except `safe-log.ts`), `src/app/api/abdm`, `src/app/api/nhcx`, `src/app/api/rcm/nhcx`, `src/app/api/cron`, `src/app/api/settings/integrations`.
  2. The word `aadhaar` (any case) appears under `src/lib/abdm` and `src/app/api/abdm` only in an allowlist:
     - `src/lib/abdm/constants.ts` (paths, `loginHint` values);
     - `src/lib/abdm/gateway.ts` (method names);
     - `src/lib/abdm/http-adapter.ts`, `src/lib/abdm/mock-adapter.ts`;
     - `src/lib/validation/abha-flow.ts`;
     - `src/app/api/abdm/abha/enrol/otp/route.ts`, `src/app/api/abdm/abha/login/otp/route.ts`.
  3. In the two OTP routes, the identifier holding the Aadhaar value appears only in the zod parse and the `gw.encrypt(...)` call: `src.match(/body\.aadhaar|data\.aadhaar/g)!.length === 1` and that line contains `encrypt(`.
  4. `logAudit(` and `logGatewayEvent(` calls in SP8 files never interpolate an identifier named `otp`, `aadhaar`, `token`, `userToken`, `transientToken`, `abhaNumber`, `abhaAddress`, `mobile`, `policyNumber`, `memberId`, `preAuthRef`, `utr`, `payload` or `jwe` (regex over the call's argument text).
  5. `AbhaFlow` in `flow-store.ts` declares no property matching `/aadhaar|otp/i`.
  6. `mock-adapter.ts` and `mock-transport.ts` are imported only by `src/lib/abdm/registry.ts`, `src/lib/nhcx/claim-gateway.ts` and `src/lib/queries/nhcx-exchanges.ts`.
  7. No tracked file (`git ls-files`) contains `-----BEGIN` followed by `PRIVATE KEY` or `CERTIFICATE`; test keys are generated at runtime.
  8. `process.env.NHCX_ENCRYPTION_PRIVATE_KEY`, `process.env.NHCX_PREVIOUS_ENCRYPTION_PRIVATE_KEY`, `process.env.ABDM_CLIENT_SECRET` and `process.env.INTEGRATION_PAYLOAD_KEY` are read only in `src/lib/integrations/config.ts` / `payload-vault.ts`.
  9. No file under `src/app/(dashboard)` or `src/components` imports from `src/lib/integrations/config.ts` except the settings page (server) — and no client component imports it.
- `sessionless-routes.test.ts`:
  - `SESSIONLESS_ROUTES = ['src/app/api/nhcx/callback/[...action]/route.ts', 'src/app/api/abdm/api/v3/hip/patient/share/route.ts', 'src/app/api/cron/nhcx-sweep/route.ts', 'src/app/api/webhooks/fhir-labs/route.ts']`.
  - Every `route.ts` under `src/app/api` either calls `requireSession(` or is in this list (plus the pre-existing public routes the test enumerates from the current tree: `login`, `logout`, `patient-portal/**`, `public/**`, `intake/**`, `queue-display`, `auth/**`, `book`). The test asserts the SP8 additions specifically and fails on any new unlisted route.
- `conformance.test.ts`:
  - For a matrix of SP7 snapshot fixtures (ipd/daycare/opd claims; initial/enhancement pre-auths; with and without ABHA; with TPA; with 0/1/3 documents; amounts above 2^31 paise), `validateNhcxBundle` of every builder output is `[]`.
  - The JSON never matches `/uidai|"ADN"|telecom|"address"|\b\d{12}\b/`.
  - Every `Money` has `currency: 'INR'`, and a decimal value with ≤ 2 places.
  - Every `reference` resolves.
  - Every bundle's `meta.profile[0]` is the S5 canonical URL.
- **Optional CI step** (documented, not run here):

  ```
  java -jar validator_cli.jar out/*.json -version 4.0.1 -ig ndhm.in#6.5.0
  ```

  `validator_cli.jar` is the HAPI/HL7 validator. A `scripts/nhcx-dump-fixtures.ts` (tsx) writes the conformance matrix bundles to `out/`. Its result is advisory: terminology-binding warnings for local service codes are expected (U15).

- [ ] **Step 1: Write the three test files** as above.
- [ ] **Step 2: Run:** `npx vitest run tests/lib/no-integration-secret-leak.test.ts tests/api/sessionless-routes.test.ts tests/lib/fhir/nhcx/conformance.test.ts tests/lib/no-aadhaar-leak.test.ts tests/lib/no-credential-leak.test.ts`. Fix every violation in the source, never by widening an allowlist without a comment naming the reason.
- [ ] **Step 3: Delete** the legacy eligibility components after the grep check. Write the docs additions and `scripts/nhcx-dump-fixtures.ts`.
- [ ] **Step 4: Verify the branch:**
  - the same command;
  - `npx vitest run tests/lib/abdm tests/lib/nhcx tests/lib/fhir tests/lib/integrations tests/api tests/pages tests/components`;
  - `npm test -- tests/api/rbac-route-gates.test.ts tests/db/sp8-schema.test.ts tests/lib/queries/nhcx-exchanges.test.ts tests/lib/nhcx/inbound.test.ts tests/lib/queries/claim-submissions.test.ts`;
  - `npx tsc --noEmit`;
  - `npx eslint src/lib/abdm src/lib/nhcx src/lib/fhir src/lib/integrations src/app/api/abdm src/app/api/nhcx src/app/api/rcm/nhcx src/app/api/cron src/components/abdm src/components/nhcx`;
  - `npm run build`.

  All must PASS.
- [ ] **Step 5: Commit**

```bash
git add tests src/components docs/ABDM-NHCX.md scripts/nhcx-dump-fixtures.ts
git commit -m "test(sp8): integration secret and Aadhaar leak guards, session-less route allowlist and NHCX conformance matrix"
```

---

## Appendix: Phase 2 (not tasks): HIP care-context linking and consent artefacts (ABDM M2/M3)

The spec says "ABHA verify/link/consent artefacts". SP8 covers this as follows:
- **ABHA verify and link:** Tasks 4–6.
- **Consent artefacts, read as ABDM M1 consent for ABHA enrolment and verification:** Task 5's `abdm_consents`.

ABDM **M2** (HIP: care-context linking, consent notification, encrypted health-record push) and **M3** (HIU: consent requests and data pull) are **not required for NHCX claims**. NHCX needs only participant onboarding and, optionally, the ABHA in the claim (S3). They are a separate certification track: functional test plus WASA (S1 going-live.mdx). They are planned as a future sub-project with these boundaries, so nothing in SP8 blocks them.

- **HIP-initiated linking** (S1 `hiecm-m2.yaml`):
  - `POST /api/hiecm/v3/token/generate-token` (headers `X-CM-ID`, `X-HIP-ID`; callback `/api/v3/hip/token/on-generate-token`);
  - then `POST /api/hiecm/hip/v3/link/carecontext` (header `X-LINK-TOKEN`; callback `/api/v3/link/on_carecontext`);
  - then `POST /api/hiecm/hip/v3/link/context/notify`.
  - Care contexts map to SP3 encounters and SP5 lab reports.
- **User-initiated linking callbacks:** `/api/v3/hip/patient/care-context/discover`, `/link/care-context/init`, `/link/care-context/confirm`, answered on the `/api/hiecm/user-initiated-linking/v3/...` `on-*` endpoints.
- **Consent and data flow (HIP):**
  - consent notify `/api/v3/consent/request/hip/notify` → `/api/hiecm/consent/v3/request/hip/on-notify`;
  - data request `/api/v3/hip/health-information/request` → `on-request`, then push to `dataPushUrl` with the Fidelius scheme (ECDH Curve25519, HKDF-SHA256, AES-256-GCM; S1 [observed, annex]), then `/api/hiecm/data-flow/v3/health-information/notify`.
  - FHIR documents per S5 (DischargeSummary, DiagnosticReport, Prescription, Invoice) from SP3, SP5 and SP4 data.
- **Reuses from SP8:** `getGatewayToken`, `abdmHeaders`, `verifyAbdmCallback` (Task 6), the bridge URL `<app>/api/abdm`, `safeLog`, `logGatewayEvent` and the vault.
- **New in Phase 2:** a consent-artefact table (artefact id, HI types, date range, expiry, status, revocation), a care-context table, an X25519 key-exchange helper (`node:crypto` `diffieHellman` with X25519), and a data-push job with the same outbox pattern as Task 11.
- **Needs from the owner:** a decision on which record types to share, M2 certification, and the WASA audit.

## Execution notes

**Model tier and DB need per task:**

| Task | Tier | Local DB |
|---|---|---|
| 1 Runtime/config/log/audit/certs/vault/roles | standard | no |
| 2 Schema | standard (triggers, partial unique, scrub check) | **yes** (apply migration twice) |
| 3 ABDM encryption + session | standard (OAEP-SHA1 subtlety, single-flight cache) | no |
| 4 AbdmGateway adapters | standard | no |
| 5 ABHA flows + linking + UI | **most capable** (secret-handling discipline, registration integration) | **yes** (abha-link DB test, harness) |
| 6 Scan & Share | standard | **yes** |
| 7 Headers + JWE | standard | no |
| 8 NHCX client | standard | no |
| 9 Base resources, eligibility, validator, fixtures | standard (fixture de-identification is mandatory) | no |
| 10 Claim bundles + parsers | standard | no |
| 11 Gateway + outbox + dispatch | **most capable** (transaction boundaries, lease, same-id retry, SP7 edits) | **yes** |
| 12 Callback receiver | **most capable** (ordering of checks, replay, review-only rule) | **yes** |
| 13 Polling + sweep | standard | **yes** |
| 14 Eligibility | standard | **yes** |
| 15 Settings page + RCM panel | standard | harness only |
| 16 Guards + conformance | cheap | harness only |

**Order:** 1 → 2 → 3 → 4 → 5 → 6, then 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16. Tasks 3–6 (ABHA) and 7–10 (NHCX pure/protocol) are independent once Task 2 lands and can run in parallel worktrees. Tasks 5, 6, 11, 13, 14 and 15 edit `rbac-route-gates.test.ts`, and 6 and 15 edit `LeftNav.tsx` and `page-gates-harness.ts`: serialise those. Task 11 edits SP7 `claim-submissions.ts` and Task 15 edits SP7 components; run the named SP7 tests in each.

**Rulings made in this plan:**

1. **Real vs mocked.**
   - The real adapters (ABHA V3 HTTP, NHCX JWE client) are the only code paths in production.
   - The mocks (`mockAbdmGateway`, `mockTransport`) are reachable only when `ABDM_USE_MOCKS=1` and neither `NODE_ENV` nor `VERCEL_ENV` is `production`. They are labelled in the UI, flagged on every row (`is_mock`, `abdm_sandbox_mock`), never fabricate approval amounts, and are imported only by the registries.
   - With neither credentials nor the flag, the UI says "not configured" and the routes return 503.
   - Spec §3 says "sandbox/mock implementation by default"; §3 also says "No fake data in production … mocks only behind an explicit env flag". The stricter, later rule governs.
   - The real *sandbox* (dev.abdm.gov.in, apisbx) is used through the real adapters, with sandbox URLs in env.
2. **Secrets.**
   - All credentials and keys come from env (base64 PEM for keys and certs); the names are in `.env.example`, the values are never committed, and tests generate their keys.
   - The ABDM client secret is read only by `config.ts`. The NHCX private keys are read only there and used only by `jwe.ts`.
   - The settings page shows presence, the certificate subject, fingerprint prefix and expiry, never values. Test-connection performs a token fetch only.
   - A secret store (Vercel env is the store for this deployment model) is the operator's choice. If a KMS is later required, `config.ts` is the single seam.
3. **Crypto library.**
   - `jose` (already a dependency): JWE compact encryption/decryption, X.509 import and JWT verification (ABDM and NHCX callbacks).
   - `node:crypto`: ABHA field encryption, because the RSA/ECB/OAEPWithSHA-1AndMGF1Padding raw encryption of a short string is not a JOSE operation; plus `X509Certificate` for expiry and the existing AES-256-GCM for at-rest sealing (with a separate key, `INTEGRATION_PAYLOAD_KEY`, not the Aadhaar key).
   - The Swasth `hcx-integrator-sdk` is not adopted: it targets Swasth HCX auth (Keycloak password grant), is ESM-only without types, was last published 2024-02, and differs from NHCX on auth, headers and alg (S6, S3).
4. **Data retention.**
   - Aadhaar numbers, OTPs and passwords are never stored anywhere (S1 build-it-well).
   - ABDM user tokens live only in an encrypted Redis flow entry with a 900 s TTL.
   - ABHA API responses are not stored. Only the resulting ABHA number/address and the verification columns (`abha_verified_*`) are kept.
   - Scan & Share profiles are kept for 24 h if unresolved, then scrubbed.
   - Outbound NHCX bundles are not stored; they are rebuildable from SP7's immutable snapshots. Only `body_sha256` is kept, and the sealed JWE only until accepted (needed for identical retries).
   - Inbound decrypted FHIR payloads are stored **encrypted at rest** (`payload_encrypted`) with their SHA-256 and a no-free-text summary. They are retained with the claim record and are not auto-purged in SP8; deletion follows SP7's financial-records rule. Raw inbound JWEs are never stored.
   - `nhcx_inbound_calls` (ids only) are purged after 30 days.
   - Audit and log lines carry ids, enums and codes only. The owner must confirm the legal retention period for claim correspondence (A1).
5. **Polling vs callbacks.**
   - Callbacks (`on_*`) are the primary path.
   - The cron sweep (every 15 min) is the safety net: it retries unsent outbox rows (1 m, 5 m, 15 m, 1 h, 6 h, then `send_failed`), marks requests silent for 7 days as `no_response` with a claim note, and, only when `NHCX_STATUS_POLLING=1` (default off, because the status payload is unverified), polls exchanges silent for over 2 h at most every 6 h.
   - RCM can request a status check at most every 15 min per exchange.
   - A late callback after `no_response` is still accepted (the correlation exists) and moves the exchange to `responded`.
6. **NHCX never moves status or money on its own.** Inbound ClaimResponses, queries and payment notices become exchange rows plus SP7 `note` events by "NHCX gateway". RCM reviews each one and applies it through the existing SP7 forms, pre-filled. This keeps SP7's two-copy, audit and settlement invariants (one human-entered UTR per settlement, approval reconciliation) intact, and means an unverified response mapping can never corrupt the ledger. Revisit once real payer responses have been observed (A2).
7. **Insurer/TPA not on NHCX.** A payer whose profile has no `nhcxParticipantCode` is "not on NHCX":
   - the `nhcx` channel is disabled with the reason;
   - the eligibility panel says to use the insurer portal;
   - the manual channels (portal, email, courier, hand delivery) work exactly as in SP7.

   An NHCX build or send refusal never blocks a manual resubmission.
8. **Recipient.** Messages go to the TPA's participant code when the policy has a TPA with one (S3: address the processing entity), else to the insurer's.
9. **GST in claim items.** `Claim.item.net` is the GST-inclusive line total from the SP7 snapshot and `unitPrice` the pre-tax unit price. The CGST/SGST/IGST split stays in the insurer-copy PDF: the snapshot has no split, and S5 `ndhm-price-components` has no IGST code (A4).
10. **Scope boundary.**
    - SP8 = ABDM M1 (ABHA create, verify and link, consent capture, Scan & Share) plus NHCX provider flows (eligibility, pre-auth, claim, communication, payment notice).
    - HIP care-context linking and HIU consent artefacts (M2/M3) are the Phase 2 appendix.
    - Predetermination is excluded: NHCX has no `predetermination` path (S2).
    - Insurance-plan discovery (`/v1/insuranceplan`) and notification subscriptions (`/v1/notification/subscribe`) are excluded.
11. **Correlation and tracking.**
    - Each claim *version* is its own correlation (new `claim/submit`).
    - A query response reuses the insurer's communication correlation (`communication/on_request`).
    - SP7's dispatch `trackingReference` = the outbound correlation id.
    - Retries reuse the exchange's `api_call_id` and identical JWE bytes; status polls use new `api_call_id`s with the original correlation.
12. **ABHA verification state.** "Recorded" (SP1, typed) and "verified" (SP8, `abha_verified_at` set by ABDM or a Scan & Share) are distinct and both shown. A verified ABHA is linked only to the patient the staff member chose; a conflict with another patient's ABHA is a 409 and is never auto-merged.

**UNVERIFIED register.** Each item is implemented as a single constant or env value, with a test, so it can be corrected without a redesign:
- **U1** NHCX token header name `bearer_auth` (S3 only; S2 Swagger declares no security scheme). Confirm against the NHCX Postman collection in `https://hcxsbx.abdm.gov.in/#/documents`.
- **U2** NHCX hosts `https://apisbx.abdm.gov.in/hcx`, `https://apisprod.nha.gov.in/hcx` and the participant-service hosts (S3). Env-only; confirm at onboarding.
- **U3** NHCX authenticates with the ABDM gateway session (`/api/hiecm/gateway/v3/sessions`, same client credentials) (S3). Confirm against "Authenticating with NHCX.pdf" on the portal.
- **U4** NHCX JWE `alg` `RSA-OAEP-256` (S3) vs HCX v0.8 `RSA-OAEP` (S4). We send `RSA-OAEP-256` and accept both. Confirm against the NHCX encryption document.
- **U5** `x-hcx-workflow_id` numeric stage codes (S3 "Workflow Status Sheets"). Not sent. Confirm whether NHCX requires it.
- **U6** NHCX callback JWT signing key source and the NAT IP list (S3). Operator-supplied `NHCX_GATEWAY_SIGNING_CERT` and `NHCX_CALLBACK_IP_ALLOWLIST`. Confirm with NHA.
- **U7** How NHCX composes the callback URL from `endpoint_url` (with or without `/v1`). Both are accepted.
- **U8** The NHCX synchronous-ack body `result` object (S3). The S4 `SuccessResponse` is sent.
- **U9** `/v1/status` request payload and the `on_status` callback path. Polling is off by default.
- **U10** Participant search request body and `encryption_cert` format on the NHCX participant service (S4 registry shape assumed; S2 lists `/participant/search` and `/fetch/certs`).
- **U11** Whether NHCX dedupes a resent identical `api_call_id`.
- **U12** Production ABHA base URL, production `X-CM-ID`, and the production Scan & Share QR host (S1 leaves them blank). Env-only.
- **U13** ABDM callback JWT verification keys (`/api/hiecm/gateway/v3/certs` appears only in the raw spec; S1 callback-authenticity says "confirm at onboarding"). Env `ABDM_GATEWAY_JWKS_URL`.
- **U14** The FHIR identifier system for ABHA addresses (none in S5 examples). Emitted without a system.
- **U15** Insurer acceptance of hospital-local namespaces (service codes, policy numbers, payer ids, claim numbers); NMC/SMC registration as a `MD`-typed Practitioner identifier without an HPR id; the HBP package code system; the resubmission `related` code; which `ClaimResponse.total` category carries the approved amount (`benefit` assumed; the S5 example uses `eligpercent`).
- **U16** The verbatim NHA consent text for ABHA enrolment (consent code `abha-enrollment` version `1.4` is verified, S1). The owner installs the text file.
- **U17** The `on-share` `profile.expiry` unit and meaning, and how services and facilities are bound to the bridge (no API found, S1).
- **U18** The legal retention period for claim correspondence payloads (IRDAI / DPDP); see A1.
- **U19** The `x-hcx-ben-abha-id` and `x-hcx-request_id` headers (S3 only). ABHA is sent only when the snapshot carries it; `request_id` is not sent.
- **U20** The NHCX callback 30-second ack deadline and 5 retries (S3). Our handler answers well within 30 s because all work is one short transaction.

**Ambiguities flagged for the owner:**
- **A1. Retention:** confirm how long inbound insurer payloads and claim correspondence must be kept (default: with the claim record, never auto-deleted).
- **A2. Auto-apply:** SP8 requires an RCM user to confirm every NHCX response. If the hospital later wants automatic application of, e.g., queries or pre-auth approvals, that is a follow-up after observing real payer responses.
- **A3. Cron:** the sweep needs `vercel.json` `crons` (or an external scheduler) and `CRON_SECRET`. The plan does not create `vercel.json`, because the repo has none and adding it changes deployment config.
- **A4. GST in NHCX items:** GST-inclusive `net` per line; if an insurer requires CGST/SGST detail lines, SP7's snapshot must first carry the split.
- **A5. Mandatory ABHA (owner requirement 3):** SP8 makes ABHA verifiable but does not block registration without it. SP1's documented "ABHA not available" reasons remain, because ABHA creation needs the patient's consent and an OTP device.
- **A6. Real onboarding:** NHA sandbox registration, HFR ID, NHCX participant registration, the functional test, the WASA audit and the sandbox exit are owner/legal steps (spec §7); `docs/ABDM-NHCX.md` lists them.
- **A7. Doctor identifiers:** NHCX examples use HPR ids for practitioners. SP1 stores NMC/SMC registration. Adding an HPR id field to providers is a small follow-up if payers require it.
