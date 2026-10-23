# White-label branding admin: design

**Date:** 2026-10-23 · **Status:** approved under the owner's standing instruction ("do not ask me anything, keep going") · **Parent:** `docs/superpowers/specs/2026-10-23-hospital-completion-design.md` · **Plan:** `docs/superpowers/plans/2026-10-23-white-label-admin.md`

## 1. Intent

Owner request: "make this like a white-label deployment for hospitals so that they can customise their own."

Today branding comes only from `BRAND_*` environment variables (`src/lib/brand.ts`), and a rebuild and redeploy are needed to change it, because the values are baked into prerendered pages and module-level constants. After this work, a hospital administrator sets up and changes the hospital's own identity from **Settings > Branding**, with a live preview. There is no rebuild and no developer involved, and the change applies everywhere the product shows its identity. The vendor's `BRAND_*` env vars still work, but only as first-run defaults.

One database per hospital, as now. This is **not** shared-database multi-tenancy.

## 2. Decisions (rulings where the request was silent)

| # | Topic | Ruling | Reason |
|---|---|---|---|
| D1 | Layering | Each field resolves on its own: DB column (non-null) → `BRAND_*` env → built-in neutral default (`HIMS`, stock blue, `Hospital information management system`). | A hospital can override one field and keep the vendor's value for the rest. "Reset to defaults" nulls the columns. |
| D2 | Storage shape | One singleton row `brand_settings` (id = 1, inserted by the migration) plus `brand_assets` (one row per asset kind). | It matches the `billing_settings` singleton pattern. Assets carry hashes and sizes that do not belong in the text row. |
| D3 | Legal name, address, GSTIN, ROHINI, HFR | **Not duplicated.** Legal name, address and registration ids are read from `billing_settings` (`legal_name`, `address`, `gstin`, `rohini_id`, `hfr_id`). Branding shows them read-only with a link to `/billing/rules`, where `BillingSettingsForm` edits them. Legal-name resolution: `billing_settings.legal_name` → `BRAND_LEGAL_NAME` → display name. | One source for tax documents. GST invoices must carry the GST-registered legal name. |
| D4 | `app_settings.practice_name` | Kept as is. It joins the print-header chain: `brand_settings.print_header_text` → `billing_settings.legal_name` → `app_settings.practice_name` → env legal name. The Practice tab gets a hint linking to Branding. | Existing discharge and prescription prints read it today. Removing it is a separate clean-up. |
| D5 | Cookie prefix | **Env only** (`BRAND_COOKIE_PREFIX`), and never shown as editable. `cookieName()` stays synchronous and env-backed: `proxy.ts`, `auth.ts`, `patient-session.ts` and `mfa-pending-session.ts` are unchanged. | Changing the prefix at runtime would sign everyone out, and the proxy cannot read the DB. |
| D6 | External logo URL | Only `BRAND_LOGO_URL` (env default) may be an external URL, validated as today: https only, no credentials, or a same-origin path. **The admin screen accepts uploads only.** | No admin-entered external fetches, no mixed content, and no tracking pixels. |
| D7 | Image handling | Every upload is decoded and **re-encoded to PNG by `sharp`**, which strips metadata and defeats polyglot files. SVG is pre-checked (§6) and then **rasterised to PNG**. The product never stores or serves SVG. `sharp` becomes a direct dependency, pinned to the exact version Next already resolves (`npm ls sharp`, currently `0.35.4`). | Rasterising removes the whole SVG script and external-reference class of bugs. PNG also embeds in pdf-lib lab reports. |
| D8 | Logo variants | `light` (required for logo display), `dark` (optional; falls back to light), `icon` (optional square). Favicon and app icons (32, 180, 512 px) are derived from `icon` if uploaded, else from `light` (contained on a transparent square), else from the built-in glyph tinted with the accent. | This covers the favicon requirement without asking for three uploads. |
| D9 | Accent contrast | **Auto-adjust, never refuse.** The stored value is the colour the admin entered. Light and dark variants are derived deterministically at render time (§5.3), and the screen shows "Adjusted for readability: #xxxxxx". | Darkening (light theme) or lightening (dark theme) along OKLCH L always reaches AA, so refusing is never necessary. |
| D10 | Dark theme | When an accent is set, the dark theme's `--primary` becomes the computed dark variant. Today it is a neutral near-white. With no accent the stock dark theme is unchanged. | Requested: a "computed dark-mode variant". |
| D11 | Caching | The project does **not** enable `cacheComponents` (`next.config.ts`). It uses the previous-model APIs documented in `node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md`: `unstable_cache(loader, ['brand-settings-v1'], { tags: ['brand-settings'], revalidate: 300 })`, invalidated on every save with `revalidateTag('brand-settings', { expire: 0 })` from the Route Handler. The deprecated one-argument form is not used, and `updateTag` is only for Server Actions, which this repo does not use for settings. The root layout and `generateMetadata` call `await connection()` (`next/server`), so no page is ever prerendered with a stale brand. The 300 s `revalidate` is a safety net for multi-replica self-hosting, where a tag invalidation reaches only the local instance. On Vercel the data cache is shared. | Turning on Cache Components is an app-wide migration out of scope here. Making the layout dynamic is what removes the "rebuild to rebrand" constraint. |
| D12 | Login options | Background presets `aurora` (default), `aurora_soft`, `aurora_vivid`, `gradient` (static gradient only), `plain`. Welcome line up to 120 chars. Toggle for the "Department sign-in pages" list. Hiding the list never disables `/login/[role]` URLs. | Maps onto the `AuthBackground` component from `feat/hc-login`. |
| D13 | Email | Emails stay **plain text** (`src/lib/email.ts`, notify email channel). Branding adds a text signature appended to every body, and subjects use the display name. No stored HTML anywhere. | No HTML-injection surface. The "email header" in the preview shows sender name, subject and signature. |
| D14 | SMS | `hospitalName` template var = `sms_name ?? display name`. DLT sender id stays env (`SMS_DLT_SENDER_ID`). | DLT registration is regulated. The name is a template variable, so changing it needs no re-registration. |
| D15 | MFA issuer | It is resolved from the brand at **enrolment** time. Verification never depends on the issuer. | Authenticator labels follow the new name for new enrolments. Existing entries keep working. |
| D16 | Concurrency | `brand_settings.revision`. A PUT must send the revision it loaded; a mismatch returns 409. | Two admins editing at once never silently overwrite each other. |
| D17 | Who | `BRAND_SETTINGS_ROLES = MASTER_DATA_ADMIN_ROLES` = `['admin']` for every branding read and write route and the page. `pi` keeps the other Settings tabs but not Branding. | The request says admin only. |
| D18 | Onboarding | A checklist card on every dashboard page, shown to admins only until all five items are done or it is dismissed: name, logo, colour, support contact, test sign-in (confirmed by the admin after opening `/login` in a private window). | Requested. Manual confirmation avoids coupling the login route to branding. |
| D19 | Portal name | `portal_name` (default "Patient portal") is used in the `/login` portal link, the patient-portal login heading and the `PatientPortalSideNav` section label. | These are the places that name the portal. |

## 3. Data model

Migration `scripts/migrations/2026-10-25-wl-brand-settings.sql` (`BEGIN; … COMMIT;`, re-runnable). `src/db/schema.ts` gets a block `// WL T3` … `// end WL T3`. Neither table references `patients` or `users`, so `clearExistingData` in the seed keeps them (like `billing_settings`).

**`brand_settings`** (singleton)

| column | type | rule |
|---|---|---|
| `id` | integer PK default 1 | `CHECK (id = 1)`; row inserted `ON CONFLICT DO NOTHING` |
| `revision` | integer not null default 0 | incremented on every write |
| `display_name` | text | ≤ 60 chars |
| `tagline` | text | ≤ 160 |
| `support_email` | text | ≤ 254, email regex from brand.ts |
| `support_phone` | text | ≤ 20, `^\+?[0-9][0-9 -]{5,18}$` |
| `accent_color` | text | `^#[0-9a-f]{6}$` (lower-case, `#rgb` expanded before save) |
| `login_background` | text | `IN ('aurora','aurora_soft','aurora_vivid','gradient','plain')` |
| `login_welcome` | text | ≤ 120 |
| `login_show_department_list` | boolean not null default true | |
| `portal_name` | text | ≤ 40 |
| `print_header_text` | text | ≤ 120 |
| `print_footer_text` | text | ≤ 200 |
| `print_signature_line` | text | ≤ 80 |
| `email_signature` | text | ≤ 300, up to 4 lines (only `\n` kept; other control characters stripped) |
| `sms_name` | text | ≤ 30 |
| `onboarding_test_signin_at` | timestamp | |
| `onboarding_dismissed_at` | timestamp | |
| `updated_at` | timestamp not null default now() | |
| `updated_by_name` | text | |

Every length is also a `CHECK (char_length(col) <= n)`.

**`brand_assets`**

| column | type | rule |
|---|---|---|
| `kind` | text PK | `IN ('logo_light','logo_dark','icon_32','icon_180','icon_512')` |
| `source` | text not null | `IN ('upload','derived')` |
| `blob_url` | text not null | opaque driver URL; **never leaves the server** |
| `sha256` | text not null | `^[0-9a-f]{64}$`, hash of the stored PNG |
| `content_type` | text not null | `= 'image/png'` |
| `width`, `height`, `byte_size` | integer not null | > 0 |
| `created_at` | timestamp not null default now() | |
| `created_by_name` | text not null | |

## 4. Interfaces

### 4.1 Modules

- `src/lib/brand.ts` (pure, synchronous, stays importable by `proxy.ts`). It keeps `loadBrand`, `cookieName`, `BRAND_LIMITS` and `cleanText` (exported as `cleanBrandText`). It extends `Brand` with `supportPhone`, `logoDarkUrl`, `icons`, `portalName`, `login`, `print`, `emailSignature`, `smsName` and `accent: AccentPalette | null`, all of which have env/built-in defaults in `loadBrand`. The module-level `brand` constant is **renamed `envBrand`** and documented as the env layer only. `brandThemeCss(accent: AccentPalette | null)` replaces the hex-based version. `appendEmailSignature(body, signature)` is added.
- `src/lib/brand-color.ts` (pure): `parseHex`, `relativeLuminance`, `contrastRatio`, `hexToOklch`, `oklchToHex`, `deriveAccentPalette(hex): AccentPalette`, and the constants `LIGHT_PAGE_BG`, `LIGHT_CARD_BG`, `DARK_PAGE_BG`, `DARK_CARD_BG`, `ON_ACCENT_LIGHT`, `ON_ACCENT_DARK` (pinned against `globals.css` by a test).
- `src/lib/brand-image.ts` (server): `sniffImageType(bytes)`, `checkSvgSafe(text)`, `processLogo(bytes, variant)`, `deriveIcons(png)`.
- `src/lib/brand-resolve.ts` (pure): `resolveBrand(env: Brand, snap: BrandSnapshot | null): Brand`, `toPublicBrand(b): PublicBrand`, `brandAssetPath(kind, sha256)`, `brandOnboardingStatus(snap)`.
- `src/lib/brand-server.ts` (server only): `getBrand(): Promise<Brand>` (never throws; on a DB error it logs the class name only and returns `envBrand`), `getPublicBrand()`, `invalidateBrandCache()`, `BRAND_CACHE_TAG = 'brand-settings'`. The cached loader returns a JSON-safe `BrandSnapshot` (ISO strings, no `Date`). Errors are caught **outside** the cached function, so a failure is never cached.
- `src/lib/queries/brand-settings.ts`: `loadBrandSnapshot()`, `getBrandSettings()`, `updateBrandSettings(input, revision, session)`, `resetBrandSettings(session)`, `putBrandAsset(...)`, `removeBrandAsset(variant, session)`, `getBrandAssetForServe(kind)`, `recordOnboarding(action, session)`. Each write runs in one transaction with its audit row.

`PublicBrand` (client context, no blob URLs, no secrets) contains: `name`, `tagline`, `logoUrl`, `logoDarkUrl`, `portalName`, `supportEmail`, `supportPhone`, `login: { background, welcomeLine, showDepartmentList }`.

### 4.2 Routes

| Route | Who | Body / result |
|---|---|---|
| `GET /api/settings/branding` | admin | `{ settings, revision, assets: { kind, path, width, height, source }[], defaults: env-layer values, linked: { legalName, address, gstin, rohiniId, hfrId } }` |
| `PUT /api/settings/branding` | admin | strict Zod, full replace of the editable fields plus `revision`. Returns `200 { ok, revision }`, `400`, `409 { code: 'revision_conflict' }` |
| `POST /api/settings/branding/reset` | admin | `{ confirm: 'RESET', revision }`. Nulls every editable field, deletes all asset rows, sets `login_show_department_list = true`, `200 { ok, revision }` |
| `POST /api/settings/branding/assets` | admin | multipart `file` + `variant` (`light`/`dark`/`icon`). Body capped at 1.5 MB by `readCappedBody`, file ≤ 1 MB (SVG ≤ 256 KB). Returns `201 { ok, asset }`, `400`, `413`, `415`, `422 { code }`, `429`, `503 storage_not_configured` |
| `DELETE /api/settings/branding/assets?variant=` | admin | `200 { ok }`; re-derives or removes icons |
| `POST /api/settings/branding/onboarding` | admin | `{ action: 'test_signin_done' | 'dismiss' }` |
| `GET /branding/[file]` | **public** (already excluded by the `proxy.ts` matcher) | `file` must match `^(logo-light|logo-dark|icon-32|icon-180|icon-512)-([0-9a-f]{16})\.png$` and the hash prefix must equal the current row's sha256. Returns 200 PNG, else 404. `icon-default-<rrggbb>.png` renders the built-in glyph (moved from `src/app/icon.tsx`, now deleted) tinted with the validated hex |

Every write route uses `requireSession`, an inline `BRAND_SETTINGS_ROLES` check before any body read, a strict Zod body, `logAudit` with field **names** only, `invalidateBrandCache()` after commit, and rows in `tests/api/rbac-route-gates.test.ts`. The page `/settings/branding` gets a row in `tests/pages/page-gates-harness.ts`.

### 4.3 Where the brand is applied

The root layout feeds `BrandProvider` with `toPublicBrand(await getBrand())` and puts `<style id="brand-theme">` in `<head>`, so first paint is already branded. `generateMetadata` provides title, description and icons. `BrandLogo` renders the light logo and the dark logo with `dark:` classes. Login: `AuthBackground` variant, `AuthCard` welcome line, department list toggle, portal name. Print: `PrintDocument`, `PrintSlip`, `DischargeSummaryDocument` callers, prescription print, lab report PDF (header text and embedded PNG logo), and invoice/receipt documents (logo and footer only; their legal name stays billing). Messages: OTP SMS and email, notification `hospitalName` var (five routes plus home collection), Google callback error text, system sender name and MFA issuer.

## 5. Behaviour details

### 5.1 Resolution
`resolveBrand(envBrand, snapshot)` applies D1 per field, D3 and D4 for the legal name and print header, maps asset rows to `/branding/<kind>-<sha16>.png`, and derives `accent = deriveAccentPalette(accent_color ?? env BRAND_PRIMARY_COLOR)` or `null`.

### 5.2 No flash and no rebuild
The layout is dynamic (`connection()`), and the theme CSS is server-rendered from validated hex only. The client never computes the first paint.

### 5.3 Accent palette
`ON_ACCENT_LIGHT` is `#fcfcfc` and `ON_ACCENT_DARK` is the hex of `oklch(0.18 0.01 60)`.
- **Light theme:** `primary` = the input darkened in OKLCH L (step 0.01, floor 0.15, chroma reduced as needed to stay in sRGB gamut) until (a) the better of `ON_ACCENT_LIGHT`/`ON_ACCENT_DARK` on it is ≥ 4.5 and (b) it is ≥ 4.5 against `LIGHT_PAGE_BG` and `LIGHT_CARD_BG`.
- **Dark theme:** `primary` = the input lightened until it is ≥ 4.5 against `DARK_PAGE_BG` and `DARK_CARD_BG`, with `ON_ACCENT_DARK` on it ≥ 4.5.
- `--brand` (decorative, `feat/hc-login`) = the input as entered.
- `AccentPalette` = `{ input, light: { primary, foreground, ratioOnPage, ratioText }, dark: { … }, adjustedLight, adjustedDark }`.

### 5.4 Errors
- Every route answers with a short user message and, where needed, a `code`. Logs carry error class names only, never values, file names, blob URLs or paths.
- An upload with no storage driver returns 503 `serviceUnavailableBody('blob')`.
- A DB failure in `getBrand` falls back to env (warns once per process per minute).
- Failed asset reads return 404 `Cache-Control: no-store`.

## 6. Security

- Admin only (D17). Upload, assets-delete and reset also call `rejectCrossOrigin` (`src/lib/csrf.ts`), because a multipart POST can be sent by a cross-site form. JSON routes rely on the repo's JSON-only rule.
- Strict Zod everywhere. All text passes `cleanBrandText` (control characters stripped, length capped). Everything renders as React text: no `dangerouslySetInnerHTML`, no stored HTML. The `<style>` tag is built only from regex-validated hex values produced by `deriveAccentPalette`.
- Uploads:
  - The magic-byte sniff must agree with the declared type (PNG `89 50 4E 47 0D 0A 1A 0A`; JPEG `FF D8 FF`; WebP `RIFF????WEBP`; SVG text whose first element is `<svg`, optionally after `<?xml …?>` and comments). Anything else returns 415.
  - `sharp` decodes with `limitInputPixels: 16_777_216` and `failOn: 'error'`, takes the first frame only and re-encodes to PNG with no metadata.
  - Dimensions: logo ≥ 64×16 and ≤ 4096×4096; icon ≥ 128×128 with aspect 0.8–1.25.
  - Output: logos fit inside 1024×256; icons at 32, 180 and 512.
- `checkSvgSafe` rejects these, case-insensitive, after the UTF-8 check: `<!DOCTYPE`, `<!ENTITY`, `<script`, `<foreignObject`, `<iframe`, `<embed`, `<object`, `<image`/`<use`/`<feImage` whose href does not start with `#`, any `href`/`xlink:href` not starting with `#`, `on[a-z]+\s*=`, `javascript:`, `data:`, `url(` not followed by `#`, `@import`, `<style` containing `url(`. Then it rasterises.
- Upload rate limit: `checkBrandUploadRateLimit(staffName)` allows 10 per 10 minutes per admin and 60 per hour in total (Upstash, appended to `src/lib/rate-limit.ts`).
- The public asset route serves only hash-matched current assets, with `Content-Type: image/png`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: public, max-age=31536000, immutable`, and never a blob URL.
- Audit: `branding: updated settings` (`fields=a,b`), `branding: uploaded asset` (`variant=light bytes=… w=… h=…`), `branding: removed asset`, `branding: reset to defaults`, `branding: onboarding` (`action=…`).

## 7. UX

`/settings/branding` (admin) has a two-column layout: a form on the left and a sticky preview on the right (stacked below the form on narrow screens). Sections:
1. Identity: name, tagline, portal name.
2. Contact: support email and phone.
3. Logo and icon: three upload slots with a thumbnail and a Remove button.
4. Colour: native colour input plus a hex text field, a contrast readout in words ("Text on buttons: 7.1:1, passes AA"), and an adjustment notice.
5. Sign-in page: background preset radio cards, welcome line, department list toggle.
6. Printed documents: header, footer, signature line, plus a read-only linked block with the legal name, address, GSTIN, ROHINI and HFR and a link to Billing settings.
7. Messages: email signature, SMS name.

The preview has four panes: sign-in card on its background (static gradient, never WebGL), nav header, 80 mm slip header, and email. It updates on every keystroke from the draft, is `inert` and `aria-label="Preview"`, and has a single `aria-live="polite"` contrast verdict.

Controls: Save, Discard changes, and Reset to defaults (a typed-confirm dialog). A `beforeunload` guard warns while there are unsaved changes; the page's own Back link confirms. Labels are associated with their fields, an error summary at the top takes focus on a failed save, and each field error is linked by `aria-describedby`.

The Practice tab shows a "Branding" link for admins. The onboarding card is described in D18.

## 8. Testing (all against the isolated `hims_test` DB, never `.env.local`)

- **Pure:** `brand-color` (known pairs: `#ffffff`/`#000000` = 21; `#767676` on white ≈ 4.54; `#ffe680` gets darkened; output always passes; dark variant passes; constants match `globals.css`). `checkSvgSafe` (each rejected pattern, plus a clean logo accepted). `sniffImageType`. `resolveBrand` layering (DB > env > default per field; legal-name and print-header chains; asset paths; accent from env when DB null). `brandThemeCss` (validated hex only; dark selectors present). `brandOnboardingStatus`.
- **Server:** `getBrand` returns env when the row is empty or the DB throws. It uses tag `brand-settings`, and the PUT calls `revalidateTag('brand-settings', { expire: 0 })` (`next/cache` mocked in `vitest.setup.ts`).
- **Routes:** role gating (non-admin roles get 403 before any body read), Zod rejection of unknown keys, 409 on a stale revision, audit has field names only. Upload: 413 over the cap, 415 for a declared/sniffed mismatch, 422 `svg_unsafe`, 422 `image_too_small`, 429 when rate-limited, 503 with no driver, success stores a PNG and the asset route serves it with immutable headers, a stale hash returns 404.
- **Components:** `BrandPreview` updates all four panes as fields change and shows the adjustment notice. `BrandingForm` dirty guard, Save disabled while pristine, error summary focus. `AuthBackground` presets.
- **Pages:** `/login` renders the stored brand with every `BRAND_*` unset (name, welcome, logo path, list hidden, plain background). `/settings/branding` redirects non-admins. Root `generateMetadata` returns the stored name and icon.
- **Guard:** no `import { brand }` / `envBrand` value import outside `src/lib/brand.ts`, `src/lib/brand-server.ts` and tests.

## 9. Vendor runbook (outline; full text in README "White-label a client" and `docs/DEPLOYING.md`)

1. Provision one database, Redis and blob storage per hospital (unchanged).
2. Set the env defaults: `BRAND_COOKIE_PREFIX` (fixed for the life of the deployment), and optionally `BRAND_NAME`/`BRAND_PRIMARY_COLOR` so the very first sign-in already looks right.
3. Deploy, run `db:migrate`, and create the first admin.
4. The admin signs in. The onboarding card guides them through name, logo, colour, support contact and a test sign-in from a private window.
5. Verify: `/login` and `/patient-portal/login` show the brand, a print slip shows the header, and an OTP email shows the signature.
6. Remove the old "Brand changes need a rebuild" warnings. Only the cookie prefix, and MFA issuer history (existing authenticator entries keep the old label), remain caveats.
7. For multiple self-hosted replicas, brand changes appear within 5 minutes unless a shared Next cache handler is configured.

## 10. Out of scope

Shared-database multi-tenancy. Custom domains per hospital (vendor DNS). Per-department branding. Custom fonts. HTML email templates. Translating UI copy. Editing the cookie prefix. Admin-entered external logo URLs. Removing `app_settings.practice_name`.
