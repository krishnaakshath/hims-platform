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
