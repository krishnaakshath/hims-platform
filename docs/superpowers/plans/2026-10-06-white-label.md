# White-label HIMS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** One codebase, many clients: every client-visible name, logo, colour, contact address and cookie/issuer string comes from per-deployment configuration, never from source.

**Architecture:** A single server-side `src/lib/brand.ts` reads and validates `BRAND_*` environment variables once and exports a typed `brand` object (safe defaults: neutral "HIMS"). A `BrandLogo` component and the root layout consume it; all string literals that said "Clinsync" read from it. Cookie names and the MFA issuer derive from `brand.cookiePrefix` / `brand.mfaIssuer`. Demo seeding takes its accounts' domain and password from env and refuses to run against production.

**Tech Stack:** Next.js 16 (App Router, `proxy.ts`), TypeScript, Tailwind v4 CSS variables, vitest.

## Global Constraints
- No hardcoded product name/logo/colour/domain in `src/` outside `src/lib/brand.ts` and its tests. Default brand is neutral: name "HIMS".
- Env values are untrusted-ish config: validate (colour regex, https/relative logo URL, length caps); never render brand text as HTML.
- Cookie names must be identical in every module that reads them (`proxy.ts`, auth, patient session, MFA pending) — one helper.
- No secrets or default passwords in the repo; seed refuses production.
- No `Tebra`/`IntakeQ`/`Clinsync` strings in user-visible UI, emails, SMS or printouts.

## Review Focus
- Brand env unset → app still boots with defaults; invalid colour/logo → falls back, never throws at import in Edge/proxy.
- Cookie rename consistency (a mismatch silently logs everyone out or, worse, skips auth in proxy).
- `BRAND_NAME` containing quotes/HTML/very long text in titles, emails, SMS, print slip, `<title>`.
- Client components cannot read server env: brand reaches them via props/context or `NEXT_PUBLIC_*`.

### Task 1: Brand module, logo, theme, metadata
**Files:** create `src/lib/brand.ts`, `src/components/BrandLogo.tsx`, `tests/lib/brand.test.ts`; modify `src/app/layout.tsx`, remove `src/components/ClinsyncLogo.tsx`.
- [ ] Failing tests: defaults; each `BRAND_*` override (`BRAND_NAME`, `BRAND_LEGAL_NAME`, `BRAND_TAGLINE`, `BRAND_SUPPORT_EMAIL`, `BRAND_LOGO_URL`, `BRAND_PRIMARY_COLOR`, `BRAND_COOKIE_PREFIX`); invalid colour/URL/prefix fall back to defaults; length caps; cookie prefix is `[a-z0-9_]{1,24}`.
- [ ] `brand` exports `name, legalName, tagline, supportEmail, logoUrl|null, primaryColor|null, cookiePrefix, mfaIssuer, systemSenderName`; `cookieName(kind)` helper returning `${prefix}_session|patient_session|pending_staff_mfa|pending_patient_mfa|pending_google_oauth`. Client-visible values also exposed through `NEXT_PUBLIC_BRAND_NAME`/`NEXT_PUBLIC_BRAND_LOGO_URL` if client components need them (prefer passing props from server components).
- [ ] `BrandLogo` renders `<img alt={name}>` when a logo URL is set, else the name as text; same `className` prop as the old component; update every importer.
- [ ] Root layout: `metadata.title`/description from brand; inject `--primary` override from `primaryColor` via a `<style>` tag built only from the validated value.
- [ ] Commit `feat(brand): env-driven brand config, BrandLogo, themed layout`.

### Task 2: Replace every hardcoded product string
**Files:** every `src/` file that mentions the old product name (grep `-i clinsync`), incl. `src/lib/auth.ts`, `patient-session.ts`, `mfa-pending-session.ts`, `mfa.ts`, `otp-delivery.ts`, `sms.ts`, `queries/eligibility.ts`, `app/prescriptions/print/page.tsx`, `app/book/page.tsx`, google callback, audit-log page, `AddClientModal`, `DeletePatientDialog`, `role-capabilities.ts`, `proxy.ts`; tests that assert those strings.
- [ ] Failing tests first: with `BRAND_NAME=Acme Health` the login page, patient-portal login, print slip, OTP email/SMS text, MFA issuer, system sender name and cookie names use "Acme Health"/its prefix; with defaults they use "HIMS"/`hims_*`.
- [ ] Replace; comments that merely mention the old name are reworded neutrally. Remove user-visible Tebra/IntakeQ wording. A repo-wide guard test fails if `src/` (excluding `src/lib/brand.ts` and `src/db/seed.ts` data) contains `clinsync` (case-insensitive).
- [ ] Commit `refactor(brand): read product name, issuer and cookies from brand config`.

### Task 3: Seed hardening and package identity
**Files:** `src/db/seed.ts`, `package.json`, `.env.example` (create), tests touching seed accounts.
- [ ] Demo account emails use `SEED_EMAIL_DOMAIN` (default `example.test`); password comes from `SEED_DEMO_PASSWORD` (required; no default); seed throws when `NODE_ENV==='production'` or `VERCEL_ENV==='production'` unless `ALLOW_PRODUCTION_SEED=1`. Update tests/scripts that rely on the old fixed accounts (find them: grep the old domain and password).
- [ ] `package.json` name `hims-platform`; `.env.example` lists every env var the app reads (grep `process.env`) grouped, with comments, no real values.
- [ ] Commit `chore(white-label): env-driven demo seed, package identity, .env.example`.

### Task 4: Docs and deployment guide
**Files:** `README.md` (rewrite top-to-bottom for the HIMS product), `docs/DEPLOYING.md`, `CLAUDE.md`/`AGENTS.md` mentions.
- [ ] README: what the product is, roles, security/Indian-compliance summary (reuse the existing role matrix section), and a "White-label a client" section: the `BRAND_*` table, per-client checklist (new Postgres DB, Redis, Blob store, `SESSION_SECRET`, `IDENTITY_ENCRYPTION_KEY`, SMTP/SMS, domain), migration + first-admin steps.
- [ ] `docs/DEPLOYING.md`: Vercel project-per-client steps, env var table, DB migration command, smoke-test list.
- [ ] Commit `docs: white-label README and deployment guide`.

### Task 5: Verification
- [ ] `npx tsc --noEmit`, eslint, the brand/guard/role harness test files pass.
- [ ] `BRAND_NAME="Acme Health" BRAND_PRIMARY_COLOR="#0a7d5a" npx next build && next start`; curl `/login`, `/patient-portal/login`, `/book` and assert "Acme Health" present and the old name absent in each HTML; run once with no BRAND_* and assert "HIMS".
