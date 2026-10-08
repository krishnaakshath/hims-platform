# ABDM and NHCX: operator runbook

This page covers connecting the HIMS to two national services:
- ABDM, for ABHA creation, verification, linking and Scan & Share;
- NHCX (the National Health Claims Exchange), for eligibility, pre-authorisation, claims, insurer queries and payment notices.

Sources cited in code comments are S1 to S6 in `docs/superpowers/plans/2026-10-07-sp8-abdm-nhcx.md`. Facts marked UNVERIFIED there are each held in a single constant or env value, so they can be corrected without a redesign.

## What is real and what is mocked

- **Real.** In production, the real adapters are the only code paths:
  - the ABHA V3 HTTP adapter;
  - the NHCX JWE client.
  The real ABDM and NHCX *sandboxes* (`dev.abdm.gov.in`, `abhasbx.abdm.gov.in`, `apisbx.abdm.gov.in`) go through these same adapters, with sandbox URLs in env.
- **Mocked.** The mocks (the ABDM sandbox mock and the NHCX mock transport) run only when both of these hold:
  - `ABDM_USE_MOCKS=1`;
  - neither `NODE_ENV` nor `VERCEL_ENV` is `production`.
  Every mock row is flagged (`is_mock = true` or source `abdm_sandbox_mock`), and every screen that shows one shows the badge **Sandbox mock - not real**. A mock never invents an approval amount.
- **Neither.** With no credentials and no mock flag:
  - every capability reports **Not configured**;
  - every action route answers `503`, for example `ABDM is not configured`.
- **Precedence.** Real credentials always win over the mock flag.

## Onboarding

This is owner and legal work (spec section 7). The steps:

1. **ABDM sandbox registration.** Register at the ABDM sandbox to get a client id and secret, and use `X-CM-ID` `sbx`.
2. **HFR ID.** Get an HFR ID for the facility. It becomes `ABDM_HIP_ID`, and it also goes into the RCM settings as the hospital HFR identifier.
3. **Bridge URL.** Set the bridge URL with `PATCH /api/hiecm/gateway/v3/bridge/url` to `<NEXT_PUBLIC_APP_URL>/api/abdm`. ABDM then calls `<bridge>/api/v3/hip/patient/share` for Scan & Share.
4. **Facility QR.** Print the facility QR code, which encodes `https://phrsbx.abdm.gov.in/share-profile?hip-id=<HFR ID>&counter-id=<COUNTER>` (sandbox, S1). The production host is UNVERIFIED (U12). Use one counter id per registration desk.
5. **NHCX participant.** Register as an NHCX sandbox participant with role `provider`.
   - The `endpoint_url` is `<NEXT_PUBLIC_APP_URL>/api/nhcx/callback`.
   - It must be on a domain hosted in India, with no IP address and no port (S3).
   - Upload the encryption certificate (see "Generating the NHCX key pair" below).
6. **Production.** To move to production, complete the sandbox exit, the WASA security audit and the functional test (S1 `going-live.mdx`). Then swap the env values to production hosts and credentials.

## Environment variables

`.env.example` lists every variable, with empty values. Store the values with `vercel env add`, and never commit them.

| Variable | Required for | Notes |
|---|---|---|
| `ABDM_GATEWAY_BASE_URL` | ABDM | Must be `https:`. Sandbox `https://dev.abdm.gov.in`, production `https://apis.abdm.gov.in` |
| `ABHA_BASE_URL` | ABDM | Sandbox `https://abhasbx.abdm.gov.in`; the production host comes from NHA (UNVERIFIED) |
| `ABDM_CLIENT_ID`, `ABDM_CLIENT_SECRET` | ABDM | The gateway session credentials |
| `ABDM_CM_ID` | ABDM | `sbx` in the sandbox |
| `ABDM_HIP_ID` | Scan & Share | The facility HFR ID |
| `ABDM_GATEWAY_JWKS_URL` | Scan & Share | Key set for ABDM callback JWTs; confirm the URL with NHA (U13) |
| `ABDM_CONSENT_TEXT_PATH` | ABHA creation | The verbatim NHA consent text file (default `docs/abdm/abha-enrolment-consent-1.4.txt`, not in the repo; U16) |
| `ABDM_USE_MOCKS` | development only | `1` enables the labelled mocks outside production |
| `NHCX_API_BASE_URL` | NHCX | Sandbox `https://apisbx.abdm.gov.in/hcx` (S3, UNVERIFIED) |
| `NHCX_PARTICIPANT_SERVICE_URL` | NHCX | Participant search (U10) |
| `NHCX_PARTICIPANT_CODE` | NHCX | Our participant code |
| `NHCX_ENCRYPTION_PRIVATE_KEY` | NHCX | One-line base64 of the PKCS#8 PEM |
| `NHCX_PREVIOUS_ENCRYPTION_PRIVATE_KEY` | key rotation | The old key, kept while senders switch over |
| `NHCX_ENCRYPTION_CERT` | NHCX | One-line base64 of our certificate PEM |
| `NHCX_GATEWAY_SIGNING_CERT` | NHCX callbacks | The NHCX key that signs callback JWTs (U6) |
| `NHCX_CALLBACK_IP_ALLOWLIST` | NHCX callbacks | Comma-separated IPv4 addresses (U6) |
| `NHCX_MAX_ATTACHMENT_BYTES` | NHCX | Total attachment bytes per message; default 10000000 |
| `INTEGRATION_PAYLOAD_KEY` | ABHA flows, NHCX | 32 random bytes, base64. The at-rest key for flow state and payloads. It is separate from `IDENTITY_ENCRYPTION_KEY` |
| `CRON_SECRET` | NHCX sweep | Bearer secret for `/api/cron/nhcx-sweep` |
| `NHCX_STATUS_POLLING` | optional | `1` enables status requests (`/v1/status`); off by default because the payload is UNVERIFIED (U9) |

NHCX also needs the ABDM gateway variables, because it authenticates with the ABDM gateway session (UNVERIFIED U3).

The settings page shows four things about each value:
- whether it is present;
- the certificate subject;
- the first 16 hex characters of its SHA-256 fingerprint;
- its expiry.

It never shows a value.

## Generating the NHCX key pair

```
openssl req -x509 -newkey rsa:2048 -nodes -keyout nhcx.key -out nhcx.crt -days 365 -subj "/CN=<participant code>"
base64 < nhcx.key | tr -d '\n'   # NHCX_ENCRYPTION_PRIVATE_KEY
base64 < nhcx.crt | tr -d '\n'   # NHCX_ENCRYPTION_CERT
```

1. Store each one-line value with `vercel env add`.
2. Upload `nhcx.crt` to the NHCX participant record.
3. Delete both local files.

Self-signed certificates are accepted in the sandbox (S3). Whether they are accepted in production is UNVERIFIED.

## Key rotation

1. Generate a new pair, as above.
2. Upload the new certificate to NHCX, through the participant update or `/v2/update/cert` (S2).
3. Move the current private key to `NHCX_PREVIOUS_ENCRYPTION_PRIVATE_KEY`, set the new key and certificate, and redeploy. Inbound payloads try the current key first, then the previous one.
4. Keep the previous key for at least 48 hours (S3 says about a day), then clear it and redeploy.

The settings page warns 30 days before the certificate expires.

## Retention

- **Never stored:** Aadhaar numbers, OTPs and passwords. They are not stored, logged, audited or echoed anywhere (S1 build-it-well).
- **ABDM user tokens:** these live only in an encrypted Redis flow entry with a 900-second TTL.
- **ABHA API responses:** these are not stored. Only the resulting ABHA number and address and the `abha_verified_*` columns are kept.
- **Unresolved Scan & Share profiles:** kept for 24 hours, then scrubbed.
- **Outbound NHCX bundles:** not stored, because they can be rebuilt from the SP7 immutable snapshots. Only their SHA-256 is kept, plus the sealed JWE until the message is accepted, so that a retry resends identical bytes.
- **Inbound decrypted FHIR payloads:** stored encrypted at rest with `INTEGRATION_PAYLOAD_KEY`, together with their SHA-256 and a summary with no free text. They are kept with the claim record and follow the SP7 financial-records rule. Raw inbound JWEs are never stored.
- **`nhcx_inbound_calls`:** these rows hold ids only and are purged after 30 days.
- **Audit and log lines:** these carry only ids, enum values and codes.

The legal retention period for claim correspondence must be confirmed by the owner (A1, U18).

## Cron

The NHCX sweep needs a scheduler. Its jobs are:
- retrying unsent messages;
- marking requests silent for seven days as `no_response`;
- optional status polling;
- the retention purges.

On Vercel, add a `crons` entry to `vercel.json`:

```json
{ "crons": [{ "path": "/api/cron/nhcx-sweep", "schedule": "*/15 * * * *" }] }
```

Set `CRON_SECRET` too. The repository does not ship a `vercel.json`, because adding one changes the deployment configuration; that is the owner's decision (A3).

## Rollback

Unset the NHCX variables and redeploy. RCM then falls back to the manual channels (portal, email, courier, hand delivery), exactly as in SP7. ABHA works the same way: unset the ABDM variables, and the registration form keeps the typed ABHA fields with the "ABDM not connected" hint.

## NHCX callbacks: caller IPs

`NHCX_CALLBACK_IP_ALLOWLIST` is empty by default, which admits any caller (the bearer JWT and the JWE still have to verify). The NHCX NAT addresses given in the NHCX documentation (S3, UNVERIFIED U6) are `3.109.99.210`, `13.126.152.0` and `13.200.129.223`; confirm them with NHA before setting the allowlist.

## Review of insurer responses

NHCX answers (claim and pre-auth responses, insurer queries, payment notices) never change a claim's status or money by themselves (ruling 6). Each one appears in the NHCX panel of the claim or pre-auth as "to review"; an RCM user opens it, applies the matching action (pre-filled, not submitted) and confirms, or dismisses it with a reason. A confirmed payment notice can send the payment acknowledgement.

## Validating bundles with the HL7 validator (optional)

`npx tsx scripts/nhcx-dump-fixtures.ts out` writes the conformance-matrix bundles to `out/`. Then:

```
java -jar validator_cli.jar out/*.json -version 4.0.1 -ig ndhm.in#6.5.0
```

The result is advisory: terminology-binding warnings for the hospital-local service codes are expected (U15).

## Phase 2 (not built): ABDM M2/M3

HIP care-context linking, consent notifications, health-record push (M2) and HIU consent requests (M3) are not needed for NHCX claims and are a separate certification track (functional test and WASA). They reuse the gateway session, the standard headers, the callback JWT check, the bridge URL, `safeLog`, gateway audit rows and the payload vault from this work. See the appendix of `docs/superpowers/plans/2026-10-07-sp8-abdm-nhcx.md`.

## Unverified facts

Each item is a single constant or env value, so it can be corrected without a redesign.

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
