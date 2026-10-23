# White-Label Branding Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hospital admin sets the hospital's name, logo, colour, sign-in page, print, email and SMS identity from Settings > Branding, with a live preview. It applies everywhere at once, with no rebuild. `BRAND_*` env vars become first-run defaults.

**Architecture:**
- Storage: a singleton `brand_settings` row and a `brand_assets` table.
- Pure modules: colour contrast (`brand-color`), resolution (`brand-resolve`), SVG and sniff checks.
- `getBrand()` server function: cached with `unstable_cache` under tag `brand-settings`, invalidated by `revalidateTag(..., { expire: 0 })` on save.
- Rendering: the root layout is made dynamic with `connection()` and feeds `BrandProvider` and a server-rendered `<style id="brand-theme">`.
- Assets: uploads are re-encoded to PNG by `sharp` and served from a public, hash-addressed, immutable route.
- Migration: existing synchronous `brand` imports move to `getBrand()` in a fixed order. A guard test closes the door behind them.

**Tech Stack:** Next.js 16.3 App Router. AGENTS.md: breaking changes. **Before touching caching, metadata, icons or routing, read:**
- `node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md`
- `03-api-reference/04-functions/unstable_cache.md`, `revalidateTag.md`, `connection.md`, `generate-metadata.md`, `image-response.md`
- `03-api-reference/03-file-conventions/01-metadata/app-icons.md`
- `01-getting-started/15-route-handlers.md`

Also: TypeScript, Drizzle + Postgres, Vitest + Testing Library, Zod 4, `@upstash/ratelimit` (existing), `sharp` (new **direct** dependency, pinned to the exact version `npm ls sharp` shows under `next`, currently `0.35.4`), pdf-lib (existing).

**Spec:** `docs/superpowers/specs/2026-10-23-white-label-admin-design.md` (decisions D1–D19). Parent: `docs/superpowers/specs/2026-10-23-hospital-completion-design.md`.

## Preconditions and assumptions

- Foundations are merged on `feat/hospital-completion`: `getBlobDriver`/`putPrivateBlob`/`getPrivateBlobBytes` (`src/lib/blob-store.ts`), `createLocalBlobDriver` (`src/lib/blob-local.ts`), `serviceUnavailableBody` (`src/lib/http/service-message.ts`), `readCappedBody` (`src/lib/http/read-capped-body.ts`), and `sendNotification` (`src/lib/notify/send.ts`).
- **Task 9 needs `feat/hc-login` merged.** That branch was read uncommitted at `.worktrees/hc-login`. This plan builds on these names and assumes them unchanged:
  - `src/components/AuthBackground.tsx`: `export function AuthBackground()`, no props; test ids `auth-bg-fallback`, `auth-bg-animation`; uses `<Aurora colorStops lightMode amplitude={0.8} blend={0.75} speed={0.35} />`.
  - `src/components/AuthShell.tsx`: `AuthShell({ children, footer })`, `AuthCard({ children, after })` (renders `<BrandLogo>` above `.auth-glass`), and the `AUTH_*` class constants.
  - CSS in `src/app/globals.css`: `--brand` (in `:root` only, not redefined under `.dark`), plus `.auth-bg-base`, `.auth-bg-grain`, `.auth-bg-vignette`, `.auth-bg-fade-in` and `.auth-glass`.
  - `brandThemeCss` in `src/lib/brand.ts` emits `:root{--brand:<hex>;}` before the light rule.
  - `src/app/login/page.tsx` is a server component rendering `<StaffLoginForm>` with a patient-portal `Link` and a `<details>` "Department sign-in pages" list. `StaffLoginForm({ portal?, children? })`. `PortalRow` is deleted.

  If hc-login has changed any of these when Task 9 starts, follow the merged code and note the difference in the commit message.
- Task 4 rewrites `brandThemeCss`. If hc-login merged first, Task 4's output keeps its `:root{--brand:…}` rule (the new signature already emits `--brand`). If Task 4 merges first, hc-login rebases onto the new signature.

## Streams (each in its own git worktree off `feat/hospital-completion`; merge in the order listed within a stream)

| Stream | Tasks | Notes |
|---|---|---|
| **0** (pure colour) | 1 | Merge first. Small and pure; Task 4 consumes it. |
| **C** (core) | 3 → 4 → 5 | Schema and queries, then `getBrand` and the layout, then the asset route. Every other stream waits for Task 4. |
| **U** (upload) | 2 → 7 | Task 2 is pure and starts at once. Task 7 waits for C's Task 4. |
| **S** (screen) | 6 → 8 → 11 | API, then screen, then onboarding card. Waits for Task 4. |
| **L** (login) | 9 | Waits for Task 4 **and** `feat/hc-login`. |
| **P** (print and messages) | 10 | Waits for Task 4. Touches many importers, so merge it last among streams to reduce rebase pain. |
| **Z** | 12 | Docs and Docker walkthrough after everything has merged. |

**Shared files and how to touch them without conflicts**
- `src/db/schema.ts`: one block appended at the end of the file, delimited `// WL T3` … `// end WL T3`. No other task edits schema.ts.
- Migrations: one file, `scripts/migrations/2026-10-25-wl-brand-settings.sql` (Task 3). `BEGIN; … COMMIT;`, every statement re-runnable. Never edit it after it has been applied anywhere. Any follow-up goes in a new `2026-10-25-wl-<topic>.sql`.
- `tests/api/rbac-route-gates.test.ts`: append rows only at the **end** of `API_GATES`, inside `// WL T<n>` … `// end WL T<n>`. `tests/pages/page-gates-harness.ts`: append only at the end of `PAGE_GATES`, same markers.
- `src/lib/role-policy.ts`: append `BRAND_SETTINGS_ROLES` at the end inside `// WL T6`.
- `src/lib/rate-limit.ts`: append `checkBrandUploadRateLimit` at the end inside `// WL T7`.
- `vitest.setup.ts`: Task 4 appends one `vi.mock('next/cache', …)` block inside `// WL T4`.
- `src/app/layout.tsx`: Task 4 owns it. `src/app/(dashboard)/layout.tsx`: Task 11 owns it (one `// WL T11` block). `src/app/(dashboard)/settings/page.tsx`: Task 8 adds one link line tagged `// WL T8`.
- `src/lib/brand.ts`: Task 4 owns it. Task 10 only deletes the `envBrand` re-export use sites outside it, and never changes `cookieName`.

## Global Constraints

- Tests run **only** against the isolated database: `source $SCRATCH/testenv.sh` (DB `hims_test`). Never `.env.local`, never the demo DB `hims`, never a cloud DB.
- Apply migrations to the test DB with `source $SCRATCH/testenv.sh && npx tsx scripts/db/migrate.ts`. **Not** `npm run db:migrate`, which loads `.env.local`. Never `db:push`.
- `brand_settings` is a shared singleton in `hims_test`. Every test that writes it calls `resetBrandSettings` (or restores the snapshot it took) in `afterEach`, so the rest of the suite keeps seeing env defaults.
- No committed secrets, `.env*` values, `data/`, or uploaded images. Test fixtures are tiny images generated in the test with `sharp` or literal byte arrays, never files from the internet.
- Never log or return a secret, a provider error body, a file path, a file name, a blob URL, or a branding field value. Log error class names only. Audit details carry field **names** and numeric sizes only.
- Times are IST for display (`formatIstDateTime`). Timestamps are stored as `timestamp` like the rest of the schema.
- Schema changes: `src/db/schema.ts` plus the re-runnable migration. Run `npx tsx scripts/db/schema-diff.ts` with the test env to confirm schema.ts and migrations agree.
- Every new route uses:
  - `requireSession()`;
  - an inline `BRAND_SETTINGS_ROLES.includes(session.role)` check **before** any body read;
  - a strict Zod body (`.strict()`);
  - `logAudit` in the same transaction as the write;
  - `invalidateBrandCache()` after commit;
  - rows in **both** RBAC harnesses (API rows, plus the page row for `/settings/branding`).

  Multipart and destructive routes also call `rejectCrossOrigin` (`src/lib/csrf.ts`).
- No stored or rendered HTML: brand values render as React text only. The `<style id="brand-theme">` content is built only from validated hex.
- `ENABLE_TRIALS=true` behaviour stays intact (`vitest.config.ts` keeps setting it). Nothing here reads or changes the flag.
- `cookieName()` and `BRAND_COOKIE_PREFIX` stay env-only and synchronous: `proxy.ts`, `auth.ts`, `patient-session.ts` and `mfa-pending-session.ts` are not modified.
- Each task ends with its tests passing, `npx tsc --noEmit` clean, `npm run lint` clean on touched files, and one commit on its stream branch.

## Review Focus

- First paint on `/login` with a stored accent and **no** `BRAND_*` env: the HTML response already has `<style id="brand-theme">`, the stored name in `<title>`, and the stored logo path. Check with `curl`, not only the browser.
- Saving branding is visible on the next request in another browser with no rebuild (tag invalidation). A DB outage on `/login` serves env branding, not a 500.
- Upload of an SVG with `<script>`, `onload=`, `<foreignObject>`, `xlink:href="https://…"`, a `data:` URI or `<!ENTITY`: rejected with 422 `svg_unsafe`, and nothing is stored. A PNG renamed `.svg`, or a declared `image/png` that is really HTML: 415.
- A non-admin (`pi` included) gets 403 on every branding route before the body is read, and is redirected away from `/settings/branding`.
- `/branding/logo-light-<wrong hash>.png` returns 404 `no-store`. No response, log or audit row ever contains a blob URL.
- A very light accent (`#ffe680`) and a very dark one (`#0a0a0a`) both produce AA-passing light and dark palettes, and the screen says it adjusted them.

---

### Task 1: Accent colour and contrast utilities (Stream 0)

**Files:**
- Create: `src/lib/brand-color.ts`
- Test: `tests/lib/brand-color.test.ts`

**Interfaces:**
- Produces:
  - `type Hex = `#${string}``
  - `parseHex(raw: string): Hex | null` (accepts `#rgb`/`#rrggbb`, any case; returns lower-case `#rrggbb`)
  - `relativeLuminance(hex: Hex): number`
  - `contrastRatio(a: Hex, b: Hex): number`
  - `hexToOklch(hex): { l: number; c: number; h: number }`
  - `oklchToHex(l, c, h): Hex` (gamut-maps by reducing chroma)
  - constants `LIGHT_PAGE_BG`, `LIGHT_CARD_BG`, `DARK_PAGE_BG`, `DARK_CARD_BG` (hex of `--background`/`--card` in `:root` and `.dark` of `src/app/globals.css`), `ON_ACCENT_LIGHT = '#fcfcfc'`, `ON_ACCENT_DARK` (hex of `oklch(0.18 0.01 60)`)
  - `interface AccentPalette { input: Hex; light: ThemeAccent; dark: ThemeAccent; adjustedLight: boolean; adjustedDark: boolean }`, where `interface ThemeAccent { primary: Hex; foreground: Hex; ratioOnPage: number; ratioText: number }`
  - `deriveAccentPalette(input: Hex): AccentPalette` (rules in spec §5.3)

- [ ] **Step 1: Write failing tests**
  - `contrastRatio('#ffffff', '#000000')` ≈ 21 (±0.01). `contrastRatio('#767676', '#ffffff')` ≈ 4.54. `parseHex('#ABC')` → `'#aabbcc'`. `parseHex('red')` and `parseHex('#12345')` → null.
  - `oklchToHex(hexToOklch('#336699'))` round-trips within 1 per channel.
  - For a table of inputs `['#194f81', '#ffe680', '#0a0a0a', '#ff0000', '#00ff00', '#ffffff', '#808080']`: `light.ratioText ≥ 4.5`, `light.ratioOnPage ≥ 4.5` against both light backgrounds, `dark.ratioOnPage ≥ 4.5` against both dark backgrounds, `dark.ratioText ≥ 4.5`.
  - `#194f81` → `adjustedLight === false`. `#ffe680` → `adjustedLight === true`, and its `light.primary` is darker than the input.
  - Deterministic: the same input gives a deep-equal output.
  - A test reads `src/app/globals.css`, extracts the four `oklch(...)` tokens, converts them, and expects the constants to match within 1 per channel.
- [ ] **Step 2: Run** `npx vitest run tests/lib/brand-color.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** using standard sRGB↔linear↔OKLab↔OKLCH formulas. Adjustment loop: step L by 0.01 (darken for light, lighten for dark), reducing chroma until the colour is in gamut, with floor L 0.15 and ceiling 0.97. If the loop ends without passing (it should not), fall back to `#1a1a1a` (light) or `#f2f2f2` (dark). No imports.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(brand): accent colour contrast utilities with WCAG AA palette derivation`.

### Task 2: Image sniffing, SVG safety and PNG re-encoding (Stream U)

**Files:**
- Modify: `package.json` / `package-lock.json` (add `"sharp": "<exact version from npm ls sharp>"` to `dependencies`, no caret)
- Create: `src/lib/brand-image.ts`
- Test: `tests/lib/brand-image.test.ts`, `tests/lib/brand-svg-safety.test.ts`

**Interfaces:**
- Produces:
  - `type BrandUploadVariant = 'light' | 'dark' | 'icon'`
  - `BRAND_UPLOAD_LIMITS = { maxBytes: 1_048_576, maxSvgBytes: 262_144, maxBodyBytes: 1_572_864, maxInputPixels: 16_777_216, maxDim: 4096, logoMin: { w: 64, h: 16 }, iconMin: 128, logoBox: { w: 1024, h: 256 } }`
  - `sniffImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml' | null`
  - `checkSvgSafe(text: string): { ok: true } | { ok: false; reason: string }` (`reason` is a fixed code such as `script`, `external_ref`, `event_handler`, `entity`, `foreign_object`, `data_uri`, never echoed input)
  - `processBrandImage(bytes: Uint8Array, declaredType: string, variant: BrandUploadVariant): Promise<{ ok: true; png: Uint8Array; width: number; height: number } | { ok: false; status: 415 | 422; code: 'type_not_allowed' | 'type_mismatch' | 'svg_unsafe' | 'image_undecodable' | 'image_too_small' | 'image_too_large' | 'icon_not_square' }>`
  - `deriveIcons(png: Uint8Array): Promise<{ size: 32 | 180 | 512; png: Uint8Array }[]>` (contain on a transparent square)
  - `renderDefaultIcon(accent: Hex, size: number): Promise<Uint8Array>` (the stethoscope glyph from `src/app/icon.tsx`, as an SVG string rasterised by sharp)

- [ ] **Step 1: Write failing tests**
  - Sniff: the PNG, JPEG and WebP magic bytes are recognised. `<?xml version="1.0"?><svg …>` and `<!-- c --><svg` → svg. HTML (`<html>`), a PDF (`%PDF`) and empty input → null.
  - `checkSvgSafe` rejects each of: `<script>`, `<SCRIPT>`, `onload="x"`, ` onclick = 'x'`, `<foreignObject>`, `<!DOCTYPE svg [`, `<!ENTITY`, `href="https://x"`, `xlink:href="//x"`, `href="data:image/png;base64,…"`, `style="background:url(https://x)"`, `@import`, `javascript:`, `<iframe>`, `<use href="other.svg#a">`. It accepts a clean logo with `<path>`, `<g>`, `<defs><linearGradient id="g">` and `fill="url(#g)"`, and `<use href="#a">`.
  - `processBrandImage`:
    - a 200×50 PNG made by sharp in the test → ok; output starts with the PNG magic bytes and has no `eXIf`/`tEXt` chunks;
    - a JPEG declared as `image/png` → 415 `type_mismatch`;
    - `image/gif` → 415 `type_not_allowed`;
    - a 40×10 PNG → 422 `image_too_small`;
    - an unsafe SVG → 422 `svg_unsafe`, and sharp is never called (spy);
    - a safe SVG → PNG at most 1024×256;
    - an icon at 300×100 → 422 `icon_not_square`;
    - a 5000×10 PNG → 422 `image_too_large`;
    - truncated PNG bytes → 422 `image_undecodable`.
  - `deriveIcons` returns three square PNGs of 32, 180 and 512. `renderDefaultIcon('#194f81', 32)` returns a 32×32 PNG.
- [ ] **Step 2: Run** `npx vitest run tests/lib/brand-image.test.ts tests/lib/brand-svg-safety.test.ts` → FAIL.
- [ ] **Step 3: Implement**
  - Decode the SVG as UTF-8 with `new TextDecoder('utf-8', { fatal: true })` (invalid → `svg_unsafe`). Lower-case it, then pattern-check.
  - Use `sharp(bytes, { limitInputPixels, failOn: 'error', animated: false })`. Read `metadata()` first for the dimension checks, then `.resize({ width, height, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer()`.
  - For SVG, use `sharp(Buffer.from(text), { density })` with the density chosen so the long edge renders at ≥ 1024. No `sharp` call ever sees an unchecked SVG.
- [ ] **Step 4: Run** → PASS. Run `npx vitest run tests/lib` for regressions.
- [ ] **Step 5: Commit** `feat(brand): image sniffing, SVG safety check and PNG re-encoding for brand uploads`.

### Task 3: `brand_settings` / `brand_assets` schema, migration and queries (Stream C)

**Files:**
- Create: `scripts/migrations/2026-10-25-wl-brand-settings.sql`, `src/lib/queries/brand-settings.ts`, `src/lib/brand-snapshot.ts` (types only)
- Modify: `src/db/schema.ts` (block `// WL T3` … `// end WL T3` at the end)
- Test: `tests/db/brand-settings-schema.test.ts`, `tests/lib/queries/brand-settings.test.ts`

**Interfaces:**
- Produces:
  - Tables exactly as in spec §3. Drizzle exports `brandSettings` and `brandAssets`, plus types `BrandSettingsRow` and `BrandAssetRow`.
  - `BRAND_ASSET_KINDS = ['logo_light','logo_dark','icon_32','icon_180','icon_512'] as const`
  - `LOGIN_BACKGROUNDS = ['aurora','aurora_soft','aurora_vivid','gradient','plain'] as const`
  - `BRAND_EDITABLE_KEYS`: the 15 editable camelCase keys, `revision` excluded.
  - `interface BrandSnapshot { settings: Omit<BrandSettingsRow, 'updatedAt'|'onboardingTestSigninAt'|'onboardingDismissedAt'> & { updatedAt: string; onboardingTestSigninAt: string | null; onboardingDismissedAt: string | null }; assets: (Omit<BrandAssetRow,'createdAt'> & { createdAt: string })[]; billing: { legalName; address; gstin; rohiniId; hfrId } | null; practice: { practiceName; practiceSite } | null }`. JSON-safe; it lives in `src/lib/brand-snapshot.ts`.
  - `loadBrandSnapshot(): Promise<BrandSnapshot>` (four narrow selects; a missing singleton row yields an all-null settings object with `revision: 0` and `loginShowDepartmentList: true`)
  - `getBrandSettings(): Promise<BrandSettingsRow>`
  - `updateBrandSettings(input: BrandSettingsInput, expectedRevision: number, session: Session): Promise<{ ok: true; revision: number; changed: string[] } | { ok: false; error: 'revision_conflict' }>`
  - `resetBrandSettings(session: Session | null): Promise<{ revision: number }>` (`null` session = test helper, no audit)
  - `putBrandAsset(kind, data: { source; blobUrl; sha256; width; height; byteSize }, session, tx?)`
  - `deleteBrandAssets(kinds: readonly BrandAssetKind[], session, tx?)`
  - `getBrandAssetForServe(kind): Promise<{ blobUrl: string; sha256: string } | null>`
  - `recordOnboarding(action: 'test_signin_done' | 'dismiss', session): Promise<void>`
  - `BrandSettingsInput` (type here; the Zod schema lives in Task 6) = the editable keys with `string | null` values and `loginShowDepartmentList: boolean`.

- [ ] **Step 1: Write failing tests**
  - Schema test (pattern of `tests/db/notification-log-schema`-style files such as `tests/db/sp4-invoices-schema.test.ts`):
    - after the migration, the singleton exists with `revision 0`;
    - a second insert with `id = 2` fails on `brand_settings_singleton`;
    - `accent_color = '#FFF'` fails the hex check;
    - `login_background = 'video'` fails;
    - a 61-char `display_name` fails;
    - `brand_assets.kind = 'banner'` fails;
    - running the migration file twice succeeds (re-runnable).
  - Queries test:
    - `updateBrandSettings` with revision 0 → `{ ok, revision: 1, changed: ['displayName','tagline'] }` and an audit row whose details are exactly `fields=displayName,tagline` (no values);
    - a second call with revision 0 → `revision_conflict` and nothing changes;
    - `loadBrandSnapshot` returns ISO strings (no `Date` instances: `JSON.parse(JSON.stringify(s))` deep-equals `s`) and includes `billing.gstin` from `billing_settings`;
    - `resetBrandSettings` nulls every editable key, sets `loginShowDepartmentList` true and deletes all asset rows;
    - `getBrandAssetForServe('logo_light')` is null before an upload.
  - `afterEach` calls `resetBrandSettings(null)`.
- [ ] **Step 2: Run** `npx vitest run tests/db/brand-settings-schema.test.ts tests/lib/queries/brand-settings.test.ts` → FAIL.
- [ ] **Step 3: Implement**
  - Migration: `CREATE TABLE IF NOT EXISTS`, named `CONSTRAINT`s, `INSERT INTO brand_settings (id) VALUES (1) ON CONFLICT DO NOTHING`.
  - Schema block mirroring it, with `check(...)` entries as in `billingSettings`.
  - Writes run in `getDb().transaction` with `SELECT … FOR UPDATE`. The revision check is `UPDATE … WHERE id = 1 AND revision = $expected RETURNING revision`.
  - Each write's audit row goes through `logAudit(session, 'branding: …', null, details, tx)`.
- [ ] **Step 4: Run** `source $SCRATCH/testenv.sh && npx tsx scripts/db/migrate.ts`, then the tests → PASS. Run `npx tsx scripts/db/schema-diff.ts` (test env) → no diff. Run `npx vitest run tests/db/seed-clear-existing-data-fk-order.test.ts tests/db/migrations-plan.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(brand): brand_settings and brand_assets tables, migration and queries`.

### Task 4: `getBrand()`, layered resolution, cached, and the branded root layout (Stream C)

**Files:**
- Create: `src/lib/brand-resolve.ts`, `src/lib/brand-server.ts`
- Modify:
  - `src/lib/brand.ts`: extend `Brand` and `PublicBrand`; rename the `brand` const to `envBrand` and keep `export const brand = envBrand` as a **deprecated alias** until Task 10; add `cleanBrandText` export, `appendEmailSignature`, and `brandThemeCss(accent: AccentPalette | null)`.
  - `src/components/BrandProvider.tsx`: default context from `toPublicBrand(loadBrand({}))`.
  - `src/components/BrandLogo.tsx`: dark logo via `dark:hidden` / `hidden dark:inline`.
  - `src/app/layout.tsx`: async; `generateMetadata`; `await connection()`.
  - `vitest.setup.ts`: `// WL T4` mock of `next/cache`.
  - `tests/lib/brand.test.ts`: update the `brandThemeCss` / `publicBrand` cases to the new signatures.
  - Delete `src/app/icon.tsx`; its glyph moves to Task 2's `renderDefaultIcon`.
- Test: `tests/lib/brand-resolve.test.ts`, `tests/lib/brand-server.test.ts`, `tests/pages/root-layout-brand.test.tsx`

**Interfaces:**
- Consumes: `deriveAccentPalette` (Task 1), `loadBrandSnapshot` / `BrandSnapshot` (Task 3).
- Produces:
  - `Brand` gains:
    - `supportPhone: string | null`
    - `logoDarkUrl: string | null`
    - `icons: { icon32: string; icon180: string; icon512: string }` (paths)
    - `portalName: string` (default `'Patient portal'`)
    - `login: { background: LoginBackground; welcomeLine: string | null; showDepartmentList: boolean }`
    - `print: { headerText: string; subline: string | null; footerText: string | null; signatureLine: string | null; address: string | null; gstin: string | null; rohiniId: string | null; hfrId: string | null; logoUrl: string | null }`
    - `emailSignature: string | null`
    - `smsName: string`
    - `accent: AccentPalette | null`

    The existing fields keep their meaning. `primaryColor` stays, as the input hex.
  - `PublicBrand = { name; tagline; logoUrl; logoDarkUrl; portalName; supportEmail; supportPhone; login }`
  - `resolveBrand(env: Brand, snap: BrandSnapshot | null): Brand` and `toPublicBrand(b: Brand): PublicBrand`
  - `brandAssetPath(kind: BrandAssetKind, sha256: string): string`, giving `/branding/logo-light-<sha[0..16]>.png` (kinds map `_` → `-`)
  - `defaultIconPath(accentHex: Hex | null, size: 32 | 180 | 512)`, giving `/branding/icon-default-<rrggbb>-<size>.png` (stock `194f81` when null)
  - `getBrand(): Promise<Brand>`, `getPublicBrand(): Promise<PublicBrand>`, `invalidateBrandCache(): void`, `BRAND_CACHE_TAG = 'brand-settings'`
  - `brandThemeCss(accent)` returns null or exactly `:root{--brand:IN;}:root:not(.dark){--primary:LP;--primary-foreground:LF;--ring:LP;}:root.dark,:root .dark{--primary:DP;--primary-foreground:DF;--ring:DP;}`

- [ ] **Step 1: Write failing tests**
  - `brand-resolve`:
    - with `snap = null`, the result deep-equals `loadBrand(env)` plus defaults;
    - a DB `displayName` beats `BRAND_NAME`, which beats `HIMS`, and this holds field by field (a DB tagline null keeps the env tagline);
    - `legalName` chain is billing → env → name;
    - print header chain is `printHeaderText` → billing legal name → `practiceName` → env legal name;
    - asset rows map to `/branding/...-<16 hex>.png`, and `blobUrl` appears nowhere in `JSON.stringify(resolveBrand(...))`;
    - `icons` fall back to `defaultIconPath` when there is no icon asset;
    - the accent comes from DB, else `BRAND_PRIMARY_COLOR`, else null;
    - `mfaIssuer` and `systemSenderName` follow the resolved name;
    - `cookiePrefix` always equals the env value even if a snapshot somehow carried one;
    - `toPublicBrand` has exactly the `PublicBrand` keys.
  - `brand-server` (`next/cache` mocked):
    - `getBrand` passes `tags: ['brand-settings']` to `unstable_cache`;
    - when `loadBrandSnapshot` throws, it returns the env brand and logs only `[brand] settings read failed (Error)`;
    - `invalidateBrandCache()` calls `revalidateTag('brand-settings', { expire: 0 })`.
  - `brandThemeCss(null)` → null; for `deriveAccentPalette('#ffe680')` the CSS contains only `#[0-9a-f]{6}` values and both selectors.
  - Root layout page test:
    - with every `BRAND_*` stubbed `''` and a stored `displayName: 'Sunrise Hospital'`, `await generateMetadata()` returns `title: 'Sunrise Hospital'` and an `icons.icon` path under `/branding/`;
    - rendering `await RootLayout({ children })` to a string with `react-dom/server` `renderToStaticMarkup` includes `id="brand-theme"` when an accent is stored and the stored name in the BrandProvider payload.
- [ ] **Step 2: Run** `npx vitest run tests/lib/brand-resolve.test.ts tests/lib/brand-server.test.ts tests/pages/root-layout-brand.test.tsx tests/lib/brand.test.ts` → FAIL.
- [ ] **Step 3: Implement**
  - `brand-server.ts` starts with a `// SERVER ONLY.` header comment like `src/lib/blob-store.ts` (the `server-only` package is not installed; do not add it). It imports `next/cache`, `react` (`cache`) and the DB query module only.
  - `cachedSnapshot = unstable_cache(loadBrandSnapshot, ['brand-settings-v1'], { tags: [BRAND_CACHE_TAG], revalidate: 300 })`. `getBrand = cache(async () => { try { return resolveBrand(envBrand, await cachedSnapshot()) } catch (e) { warn; return resolveBrand(envBrand, null) } })` with React `cache` for per-request dedupe.
  - Layout: `export async function generateMetadata(): Promise<Metadata> { await connection(); const b = await getBrand(); return { title: b.name, description: b.tagline, icons: { icon: [{ url: b.icons.icon32, sizes: '32x32', type: 'image/png' }], apple: [{ url: b.icons.icon180, sizes: '180x180' }] } } }`. `RootLayout` is async, calls `await connection()` then `getBrand()`, renders `<head><style id="brand-theme">{css}</style></head>` when there is CSS, and wraps `<BrandProvider brand={toPublicBrand(b)}>`.
  - Run `npx next build` locally (test env) and confirm `/login` is listed as dynamic (ƒ) and the build makes no DB connection.
- [ ] **Step 4: Run** → PASS. Run the whole `npx vitest run tests/lib tests/components tests/pages` → green. The `envBrand` alias keeps every existing importer compiling.
- [ ] **Step 5: Commit** `feat(brand): getBrand with DB-over-env layering, tag-cached; root layout branded at request time`.

### Task 5: Public brand asset route (Stream C)

**Files:**
- Create: `src/app/branding/[file]/route.ts`
- Modify: `tests/api/sessionless-routes.test.ts` (only if it enumerates non-`api` route files; otherwise leave it), `src/proxy.ts` comment only (line 28 describes `branding` as `public/branding/*`: update the comment to name this route; **do not** change the matcher)
- Test: `tests/api/branding-asset-route.test.ts`

**Interfaces:**
- Consumes: `getBrandAssetForServe` (Task 3), `getPrivateBlobBytes` (`src/lib/blob-store.ts`), `renderDefaultIcon` (Task 2), `parseHex` (Task 1).
- Produces: `GET /branding/[file]`:
  - `^(logo-light|logo-dark|icon-32|icon-180|icon-512)-([0-9a-f]{16})\.png$` → bytes when the hash prefix matches the current row.
  - `^icon-default-([0-9a-f]{6})-(32|180|512)\.png$` → rendered glyph.
  - Anything else → 404.
  - Headers on 200: `Content-Type: image/png`, `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`.
  - On 404: `Cache-Control: no-store`, body `Not found`.

- [ ] **Step 1: Write failing tests** (DB-backed, local blob driver in a temp dir via `BLOB_DRIVER=local`, `BLOB_LOCAL_DIR=<tmp>`):
  - store a PNG through `putPrivateBlob` and `putBrandAsset('logo_light', …)`; `GET /branding/logo-light-<first16>.png` → 200 with the exact bytes and the four headers;
  - a wrong hash → 404 `no-store`;
  - `logo-light-<hash>.svg`, `../x`, an upper-case hash and `logo-banner-<hash>.png` → 404;
  - `icon-default-194f81-32.png` → 200 PNG 32×32;
  - `icon-default-zzzzzz-32.png` → 404;
  - no session is needed;
  - the response body and headers never contain the stored blob URL (assert on `JSON.stringify([...headers])`);
  - when the blob read returns null → 404 and a log line with no URL.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (no `requireSession`: this is a public, hash-addressed, already-public image; see spec §6). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(brand): public hash-addressed brand asset route with immutable caching`.

### Task 6: Branding settings API: read, save, reset, onboarding (Stream S)

**Files:**
- Create:
  - `src/lib/brand-validation.ts`
  - `src/app/api/settings/branding/route.ts` (GET, PUT)
  - `src/app/api/settings/branding/reset/route.ts` (POST)
  - `src/app/api/settings/branding/onboarding/route.ts` (POST)
- Modify: `src/lib/role-policy.ts` (`// WL T6` `export const BRAND_SETTINGS_ROLES: readonly Role[] = MASTER_DATA_ADMIN_ROLES`), `tests/api/rbac-route-gates.test.ts` (rows at the end of `API_GATES`)
- Test: `tests/api/branding-settings.test.ts`, `tests/lib/brand-validation.test.ts`

**Interfaces:**
- Consumes: Task 3 queries, `invalidateBrandCache`, `resolveBrand`, `envBrand`, `deriveAccentPalette`.
- Produces:
  - `brandSettingsSchema` (Zod, `.strict()`): `revision: z.number().int().min(0)` plus the 15 editable keys. Text keys are `z.string().max(n * 2).nullable()` transformed with `cleanBrandText(v, n)` (empty → null). `supportEmail` must match the brand email regex. `supportPhone` must match `^\+?[0-9][0-9 -]{5,18}$`. `accentColor` goes through `parseHex`. `loginBackground` is `z.enum(LOGIN_BACKGROUNDS).nullable()`. `loginShowDepartmentList` is `z.boolean()`. `emailSignature` keeps `\n` (at most 4 lines) and strips other controls.
  - `brandResetSchema = z.object({ confirm: z.literal('RESET'), revision: z.number().int().min(0) }).strict()`
  - `brandOnboardingSchema = z.object({ action: z.enum(['test_signin_done','dismiss']) }).strict()`
  - `GET /api/settings/branding` → `{ settings: BrandSettingsInput, revision, assets: { kind, path, width, height, source }[], defaults: { name, tagline, supportEmail, accentColor, portalName, legalName }, linked: { legalName, address, gstin, rohiniId, hfrId }, palette: AccentPalette | null }`
  - `PUT` → `200 { ok: true, revision }`, `400 { error: 'Invalid branding settings', details }`, `409 { error: 'Branding was changed by someone else. Reload to see their changes.', code: 'revision_conflict' }`
  - `POST reset` → `200 { ok: true, revision }` (also deletes asset rows)
  - `POST onboarding` → `200 { ok: true }`

- [ ] **Step 1: Write failing tests**
  - Validation:
    - unknown key → 400;
    - `displayName` with `\r\nBcc:` → saved as a single line;
    - `accentColor: 'red'` → 400;
    - `'#ABC'` → `'#aabbcc'`;
    - `loginBackground: 'video'` → 400;
    - `emailSignature` with 6 lines → 400;
    - `<b>Hi</b>` is stored verbatim as text (no HTML parsing); a component test in Task 8 asserts it renders escaped.
  - Routes:
    - for each non-admin role (`ALL_ROLES` minus admin, including `pi`), GET/PUT/reset/onboarding → 403, and a `'{not json'` body still gets 403 (deny-before-parse);
    - admin PUT → 200 with revision + 1, `revalidateTag` called once with `('brand-settings', { expire: 0 })`, audit `branding: updated settings` with `fields=…` only;
    - a stale revision → 409 with no audit row;
    - reset without `confirm: 'RESET'` → 400;
    - reset → every key null and `revalidateTag` called;
    - onboarding `dismiss` sets `onboarding_dismissed_at`;
    - GET never contains `blob_url`/`blobUrl` or `local:`.
  - `afterEach` resets the singleton.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** following `src/app/api/billing/settings/route.ts` (`readJsonBody`, inline role check first). Reset also calls `rejectCrossOrigin`. Errors are logged as `[branding] <op> failed (<ErrorClass>)`. **Step 4: Run** → PASS. Add the four handlers' rows (`allowed: ['admin']`) at the end of `API_GATES` under `// WL T6`, then run `npx vitest run tests/api/rbac-route-gates.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(brand): admin branding settings API with revision guard, reset and onboarding`.

### Task 7: Logo and icon upload and removal (Stream U)

**Files:**
- Create: `src/app/api/settings/branding/assets/route.ts` (POST, DELETE)
- Modify: `src/lib/rate-limit.ts` (`// WL T7` `checkBrandUploadRateLimit(staffName: string): Promise<{ allowed: boolean }>`: 10 per 600 s per staff, prefix `ratelimit:brand-upload`, plus 60 per 3600 s global, prefix `ratelimit:brand-upload-global`), `tests/api/rbac-route-gates.test.ts` (end of `API_GATES`, `// WL T7`)
- Test: `tests/api/branding-assets.test.ts`

**Interfaces:**
- Consumes: `processBrandImage`, `deriveIcons`, `BRAND_UPLOAD_LIMITS` (Task 2); `putBrandAsset`, `deleteBrandAssets` (Task 3); `putPrivateBlob` and `getBlobDriver`; `readCappedBody`; `serviceUnavailableBody`; `rejectCrossOrigin`; `invalidateBrandCache`; `BRAND_SETTINGS_ROLES`.
- Produces:
  - `POST /api/settings/branding/assets` (multipart: `file`, `variant`):
    - `201 { ok: true, asset: { kind, path, width, height } }`
    - `400 { error: 'Choose an image file' | 'Invalid upload' }`
    - `413 { error: 'Image must be 1 MB or smaller', code: 'too_large' }`
    - `415 { error: 'Use a PNG, JPEG, WebP or SVG image', code }`
    - `422 { error, code }` (codes from Task 2)
    - `429 { error: 'Too many uploads. Try again in a few minutes.' }`
    - `503 serviceUnavailableBody('blob')`
  - Blob key: `branding/<kind>-<sha256>.png`. A light upload re-derives `icon_*` (source `derived`) unless an uploaded icon exists; an icon upload writes `icon_*` (source `upload`).
  - `DELETE /api/settings/branding/assets?variant=light|dark|icon` → `200 { ok: true }`:
    - light removes `logo_light` and the derived icons;
    - icon removes the uploaded icons and re-derives from light if there is one;
    - an invalid variant → 400.

- [ ] **Step 1: Write failing tests** (local blob driver in a temp dir; rate limiter mocked except in one test that drives it to the limit):
  - non-admin → 403 before the body is read (a huge body must not be read: spy on `readCappedBody` and expect it not called);
  - a cross-origin `Origin` header → 403;
  - `content-length` over 1.5 MB → 413 without reading;
  - a sniffed JPEG declared PNG → 415;
  - an unsafe SVG → 422 `svg_unsafe` and no `brand_assets` row;
  - a valid 400×100 PNG as `light` → 201, rows for `logo_light` plus three derived icons, audit details matching `/^variant=light bytes=\d+ w=\d+ h=\d+$/`, `revalidateTag` called;
  - the asset route then serves it;
  - an icon upload makes the icons `source = 'upload'`; deleting the icon re-derives them;
  - no driver (`NODE_ENV=production`, no token, no `BLOB_DRIVER`) → 503 `storage_not_configured`;
  - the eleventh upload in 10 minutes → 429;
  - response bodies never contain `local:` or a file name.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**: role check, `rejectCrossOrigin`, rate limit, `readCappedBody(request, maxBodyBytes)`, then `new Response(bytes, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData()`, then a strict Zod check on `{ variant }`, `processBrandImage`, the blob put, and one transaction for the rows and the audit. **Step 4: Run** → PASS; add the RBAC rows (`allowed: ['admin']`) → PASS.
- [ ] **Step 5: Commit** `feat(brand): validated logo and icon uploads with derived favicons, rate limit and CSRF origin check`.

### Task 8: Settings > Branding screen with live preview (Stream S)

**Files:**
- Create:
  - `src/app/(dashboard)/settings/branding/page.tsx` (server: `requireSessionOrRedirect`, then `if (!BRAND_SETTINGS_ROLES.includes(session.role)) redirect('/settings')` as the first statements, then load the same payload as the GET route through a shared `getBrandingAdminPayload()` exported from `src/lib/queries/brand-settings.ts`)
  - `src/components/settings/branding/BrandingForm.tsx`
  - `src/components/settings/branding/BrandPreview.tsx`
  - `src/components/settings/branding/LogoUploadSlot.tsx`
  - `src/components/settings/branding/AccentField.tsx`
  - `src/components/settings/branding/ResetBrandingDialog.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx` (`// WL T8`: in `practiceTab`, for admins, a line `<a href="/settings/branding">Branding</a> — name, logo, colours, sign-in page and printouts`, next to the existing SP8 link), `tests/pages/page-gates-harness.ts` (end of `PAGE_GATES`: `{ route: '/settings/branding', load: …, allowed: ['admin'] }` under `// WL T8`)
- Test: `tests/components/settings/BrandPreview.test.tsx`, `tests/components/settings/BrandingForm.test.tsx`, `tests/pages/settings-branding.test.tsx`

**Interfaces:**
- Consumes: Task 6 GET payload shape and PUT/reset contracts; Task 7 POST/DELETE contracts; `deriveAccentPalette`, `parseHex`, `brandThemeCss` (client-safe pure modules: verify `brand.ts` and `brand-color.ts` import nothing server-only).
- Produces:
  - `BrandPreview({ draft: BrandDraft, assets: { light?: string; dark?: string; icon?: string }, linked })`, a pure client component with four panes labelled "Sign-in page", "Navigation", "Printed slip" and "Email". `BrandDraft` = the editable keys.
  - `BrandingForm({ initial: GetPayload })`

- [ ] **Step 1: Write failing tests**
  - Preview:
    - typing "Sunrise Hospital" in the name field updates the text in all four panes;
    - the welcome line appears in the sign-in pane;
    - `loginShowDepartmentList=false` hides "Department sign-in pages" in that pane;
    - accent `#ffe680` shows "Adjusted for readability" with the adjusted hex and the preview container's style uses the adjusted primary;
    - an invalid hex shows a field error and the preview keeps the last valid colour;
    - `<b>x</b>` in the footer renders as literal text (`getByText('<b>x</b>')`);
    - the preview root has `inert` and `aria-label="Preview"`;
    - the sign-in pane never mounts `Aurora` (mock it and assert it is not called).
  - Form:
    - Save is disabled while pristine and enabled after an edit;
    - a `beforeunload` listener is registered only while dirty;
    - a failed save (mock fetch 400 with details) shows an error summary that receives focus and links to the field via `aria-describedby`;
    - 409 shows the reload message;
    - Reset requires typing RESET;
    - the upload slot posts multipart to `/api/settings/branding/assets` with `variant` and shows the 422 message for `svg_unsafe` as "This SVG contains scripts or external links. Export a plain SVG or PNG."
  - Page: `/settings/branding` as admin renders the sections (headings: Identity, Contact, Logo and icon, Colour, Sign-in page, Printed documents, Messages) and the read-only linked GSTIN block with a link to `/billing/rules`. The page gate harness passes for every role.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**
  - Follow the existing settings panel styling (`SECTION` class from the settings page; `max-w-5xl` two-column grid: `lg:grid-cols-[minmax(0,1fr)_380px]`, preview `lg:sticky lg:top-4`).
  - The preview applies the palette through `style={{ '--primary': …, '--brand': … }}` on its own container, from validated hex only. The sign-in pane uses `.auth-bg-base` / `.auth-glass` classes (from hc-login; if they are not merged yet, use an inline gradient and replace it in Task 9).
  - The native `<input type="color">` and the hex text field stay in sync.
- [ ] **Step 4: Run** `npx vitest run tests/components/settings tests/pages/settings-branding.test.tsx tests/pages` → PASS.
- [ ] **Step 5: Commit** `feat(brand): Settings > Branding screen with live preview, unsaved-changes guard and reset`.

### Task 9: Sign-in pages follow the stored brand (Stream L; needs `feat/hc-login`)

**Files:**
- Modify:
  - `src/components/AuthBackground.tsx`: `AuthBackground({ variant }: { variant?: LoginBackground })`, defaulting to `useBrand().login.background`.
  - `src/components/AuthShell.tsx`: `AuthCard` renders `<BrandWelcomeLine />` under the logo.
  - `src/app/login/page.tsx`: the `<details>` list moves into `<DepartmentSignInList />`, and the portal link text comes from `<PortalName />`.
  - `src/app/patient-portal/login/page.tsx`: the heading uses `portalName`.
  - `src/components/PatientPortalSideNav.tsx`: the section label uses `useBrand().portalName`.
- Create: `src/components/auth/BrandWelcomeLine.tsx`, `src/components/auth/DepartmentSignInList.tsx`, `src/components/auth/PortalName.tsx` (all `'use client'`, reading `useBrand()`)
- Test: `tests/components/AuthBackground.test.tsx` (extend the hc-login file), `tests/pages/login-stored-brand.test.tsx`, `tests/components/PatientPortalSideNav.test.tsx` (extend)

**Interfaces:**
- Consumes: `PublicBrand.login`, `PublicBrand.portalName` (Task 4); `getPublicBrand` (Task 4); `updateBrandSettings`, `putBrandAsset` (Task 3).
- Produces the preset mapping:
  - `aurora` = today's props;
  - `aurora_soft` = `amplitude 0.5, speed 0.2`, wrapper opacity one step lower;
  - `aurora_vivid` = `amplitude 1.0, speed 0.5`;
  - `gradient` = `auth-bg-base` + grain + vignette, never the WebGL layer;
  - `plain` = `bg-background` only (no gradient, grain or vignette).

  Reduced motion keeps every aurora preset at the static gradient (unchanged).

- [ ] **Step 1: Write failing tests**
  - `AuthBackground`:
    - with motion allowed, `variant="gradient"` never renders `auth-bg-animation`;
    - `variant="plain"` renders no `auth-bg-fallback` gradient and no grain;
    - `aurora_soft` passes `amplitude 0.5` to the mocked Aurora;
    - with no prop it reads the context value.
  - Login stored-brand page test (DB-backed):
    - stub every `BRAND_*` to `''`;
    - `updateBrandSettings` sets name "Sunrise Hospital", welcome "Welcome to Sunrise", `loginShowDepartmentList false`, background `plain` and portal name "Sunrise MyCare";
    - `putBrandAsset` stores a logo;
    - `pb = await getPublicBrand()`;
    - render `<BrandProvider brand={pb}><LoginPage /></BrandProvider>`;
    - assert the logo `img` `src` matches `/^\/branding\/logo-light-[0-9a-f]{16}\.png$/` and `alt` "Sunrise Hospital", the welcome line is visible, "Department sign-in pages" is absent, the link reads "Sunrise MyCare", and there is no `auth-bg-animation`;
    - `afterEach` resets.
  - The patient portal login heading and side-nav label read "Sunrise MyCare".
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run tests/components tests/pages` → PASS, and the hc-login tests (`tests/pages/login-unified.test.tsx`, `tests/pages/staff-login-pages.test.tsx`, `tests/pages/patient-portal-login.test.tsx`) are still green.
- [ ] **Step 5: Commit** `feat(brand): sign-in background preset, welcome line, department list toggle and portal name from settings`.

### Task 10: Move every synchronous `brand` import to `getBrand()`; print, PDF, email and SMS identity (Stream P)

**Migration order** (one commit per group if the diff is large; keep the suite green after each). Group 1 is already done in Task 4. Groups 2–6:

| Group | Files | Change |
|---|---|---|
| 1. Shell | `src/app/layout.tsx` | Task 4, already done |
| 2. Print | `src/components/print/PrintDocument.tsx`, `src/components/print/PrintSlip.tsx`, `src/app/print/token/[encounterId]/page.tsx`, `src/app/print/registration/[anonId]/page.tsx`, `src/app/print/discharge/[admissionId]/page.tsx`, `src/app/patient-portal/documents/discharge/[admissionId]/page.tsx`, `src/app/prescriptions/print/page.tsx`, `src/components/print/DischargeSummaryDocument.tsx`, `src/lib/encounters/discharge-summary.ts`, `src/components/billing/InvoiceDocument.tsx`, `src/components/billing/ReceiptDocument.tsx` (and their pages under `src/app/print/invoices`, `src/app/print/receipts`, `src/app/patient-portal/documents/receipts/[id]/page.tsx`) | `PrintDocument`/`PrintSlip` take a required `identity: Brand['print'] & { name: string }` prop. The pages `await getBrand()` and pass it. They render the header text, subline (address, GSTIN, registration ids), logo, footer and signature line. Invoices and receipts add only the logo, footer and signature: their legal name stays from billing (D3) |
| 3. Lab report | `src/lib/queries/lab-reports.ts` (`hospitalHeader`), `src/lib/labs/report-data.ts` (`hospitalFromBrand` takes `Brand['print']` + name), `src/lib/labs/report-pdf.ts` | The header uses `print.headerText`. Embed the light logo PNG (`getPrivateBlobBytes` of `logo_light`, `pdf-lib` `embedPng`, max 36 pt high) when present, and skip silently when not. Footer text goes in the page footer |
| 4. Messages | `src/lib/sms.ts`, `src/lib/otp-delivery.ts`, `src/lib/email.ts` (`appendEmailSignature`), `src/lib/notify/send.ts` (email channel text gets the signature; `hospitalName` default), `src/app/api/appointments/[id]/telemedicine/route.ts`, `src/app/api/booking-requests/[id]/confirm/route.ts`, `src/app/api/form-submissions/route.ts`, `src/app/api/lab-requisitions/[id]/report/route.ts`, `src/app/api/patients/[anonId]/lab-orders/route.ts`, `src/lib/home-collection/route-responses.ts` | `hospitalName: (await getBrand()).smsName`. Subjects use `name` |
| 5. Identity text | `src/app/api/auth/google/callback/route.ts`, `src/lib/queries/eligibility.ts` (`SYSTEM_SENDER_NAME` const becomes `async function systemSenderName()`; update `src/lib/queries/doctor-assignments.ts`), `src/lib/mfa.ts` (issuer passed in at enrolment from `getBrand()`; verification uses a fixed label and no issuer dependency) | runtime brand |
| 6. Close | `src/lib/brand.ts` | Delete the deprecated `export const brand` alias. Keep `envBrand` (used by `brand-server.ts` and tests) |

**Files:** as in the table, plus tests: `tests/lib/no-sync-brand-import.test.ts` (new), and updates to `tests/pages/print-registration-slip.test.tsx`, `tests/pages/print-token-slip.test.tsx`, `tests/pages/prescriptions-print.test.tsx`, `tests/lib/encounters/discharge-summary.test.ts`, `tests/lib/mfa.test.ts`, `tests/api/login-mfa.test.ts`, `tests/api/patient-portal-login-mfa.test.ts`, `tests/api/patient-portal-account-mfa.test.ts`, `tests/api/home-collections-routes.test.ts`, `tests/api/lab-reports-routes.test.ts`, `tests/components/errors/error-pages.test.tsx` and `tests/lib/brand-wiring.test.ts` (switch `brand` → `envBrand`, or assert against `await getBrand()`).

**Interfaces:**
- Consumes: `getBrand`, `Brand['print']`, `appendEmailSignature` (Task 4); `getBrandAssetForServe` (Task 3).
- Produces: `PrintDocument` / `PrintSlip` prop `identity` (required). `hospitalFromBrand(b: Pick<Brand,'name'|'legalName'|'print'>, site)`. `appendEmailSignature(body: string, sig: string | null): string` (`body + '\n\n-- \n' + sig` when sig is set).

- [ ] **Step 1: Write failing tests**
  - Guard test: walking `src/` finds no `import { brand }`, `import { brand,` or `brand.` usage of the module value outside `src/lib/brand.ts` and `src/lib/brand-server.ts` (regex on import lines from `@/lib/brand`; `cookieName`, `envBrand` in `brand-server.ts`, types and pure helpers allowed).
  - With a stored `printHeaderText` "Sunrise Hospital, Pune", `printFooterText` and `printSignatureLine`:
    - the token slip and registration slip render them;
    - the prescription print renders the header and logo `img` with a `/branding/` src;
    - the lab report PDF (new `tests/lib/labs/report-pdf-brand.test.ts`: call `renderLabReportPdf(data)` from `src/lib/labs/report-pdf.ts`, load with pdf-lib, assert producer/creator equal the stored name and that one image XObject is embedded when a logo exists);
    - an OTP email body ends with the signature;
    - `sendNotification` for `booking_confirmed` renders `smsName`;
    - the MFA enrolment otpauth URI carries the stored name as issuer;
    - the invoice still shows the billing legal name.
  - With no row, every one of these equals today's output (env brand).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** group by group, running the affected tests after each group. **Step 4: Run** the full `source $SCRATCH/testenv.sh && npx vitest run` → green; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `refactor(brand): print, PDF, email, SMS and MFA identity read getBrand at request time; remove sync brand alias`.

### Task 11: First-run onboarding checklist for admins (Stream S)

**Files:**
- Create: `src/components/BrandOnboardingCard.tsx` (client: dismiss and "I tested the sign-in page" buttons call `POST /api/settings/branding/onboarding`, then `router.refresh()`)
- Modify:
  - `src/lib/brand-resolve.ts`: add `brandOnboardingStatus(snap: BrandSnapshot): { items: { key: 'name'|'logo'|'colour'|'contact'|'signin'; done: boolean; href: string }[]; complete: boolean; dismissed: boolean }`.
  - `src/app/(dashboard)/layout.tsx` (`// WL T11`): for `session.role === 'admin'` only, load the snapshot through `getBrandOnboarding()` (exported from `brand-server.ts`, using the same cached snapshot), and render the card above `{children}` inside `<main>` when it is neither complete nor dismissed. Any error → render nothing.
- Test: `tests/lib/brand-onboarding.test.ts`, `tests/components/BrandOnboardingCard.test.tsx`, `tests/pages/dashboard-layout-onboarding.test.tsx`

**Interfaces:**
- Consumes: Task 3 snapshot, Task 6 onboarding route.
- Produces: the hrefs `/settings/branding#identity`, `#logo`, `#colour`, `#contact`, and `/login` (opened with `target="_blank" rel="noopener"` plus the instruction "Open it in a private window").

- [ ] **Step 1: Write failing tests**
  - Status: an empty snapshot → 0/5 incomplete. Name + light logo + accent + support phone + `onboardingTestSigninAt` → complete. `dismissed` follows `onboardingDismissedAt`.
  - Card: shows "Set up your hospital's branding", the progress "2 of 5 done" as text and a link per open item; the dismiss button posts `{ action: 'dismiss' }`.
  - Layout: admin with an incomplete status sees the card; `pi`, `frontdesk` and `billing` never do (and the onboarding loader is not called for them); a complete or dismissed status → no card; a loader that throws → no card and the page still renders.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run tests/lib/brand-onboarding.test.ts tests/components/BrandOnboardingCard.test.tsx tests/pages` → PASS.
- [ ] **Step 5: Commit** `feat(brand): first-run branding checklist for admins`.

### Task 12: Docs, vendor runbook and Docker walkthrough (Stream Z)

**Files:**
- Modify:
  - `README.md`: rewrite "White-label a client" so the env table reads "first-run defaults". Add a "Hospital self-service branding" subsection (Settings > Branding, what each field affects, what stays env-only: `BRAND_COOKIE_PREFIX`). Remove "Brand changes require a rebuild and redeploy" except for the cookie prefix. Update "Where things live" (`brand-server.ts`, `brand-resolve.ts`, `brand-color.ts`, `brand-image.ts`, `/branding/[file]`).
  - `docs/DEPLOYING.md`: in §3, change the `BRAND_*` row from "Read at build time" to "First-run defaults; the hospital admin overrides them in Settings > Branding". Replace the rebuild note with: the cookie-prefix caveat, the 5-minute propagation for multi-replica self-hosting, and that the blob storage must be configured before logos can be uploaded. Add a section "Onboarding a new hospital" covering the spec §9 steps 1–7. Extend §8 Smoke test with the branding checks.
  - `.env.example` / `.env.docker.example`: comments on `BRAND_*` as defaults.
  - `docs/superpowers/plans/2026-10-23-gap-closure-plan.md`: add a line under polish noting white-label self-service is done.
- Test: full suite + build + browser walkthrough

- [ ] **Step 1: Run** `source $SCRATCH/testenv.sh && npx vitest run` → all green (known skips documented). `npx tsc --noEmit` and `npm run lint` → clean. `npx next build` → `/login` is dynamic and the build makes no DB connection.
- [ ] **Step 2: Docker walkthrough.** Build the image with the same procedure as foundations Task 12 (Dockerfile at the main checkout root, `node:22-alpine`; confirm `sharp` loads in the container with `node -e "require('sharp')"`). Run it on a spare port against the Docker `hims` database with `BLOB_DRIVER=local`, the `hims_blobs` volume, and **no** `BRAND_*` set. Apply the migration with `npx tsx scripts/db/migrate.ts` pointed at the Docker DB. In the browser:
  1. The first admin sign-in shows the onboarding card.
  2. Set name, tagline, support phone, accent `#ffe680` (see the adjustment notice), upload a PNG logo and a safe SVG icon, then try an SVG with `<script>` (rejected).
  3. Choose the `gradient` background, a welcome line, and hide department pages. Save.
  4. In a private window `/login` shows everything on first paint (`curl -s localhost:<port>/login | grep brand-theme`), and the favicon is the new icon.
  5. Toggle dark mode: the accent is readable.
  6. Print a token slip and a prescription (header, footer, logo). Release a lab report PDF (header and logo). Trigger a staff email OTP (signature in the log-only email output).
  7. Mark the test sign-in done; the card disappears.
  8. Reset to defaults: the neutral HIMS brand returns with no restart.
  9. Confirm no blob URL or file path appears in any response or in the container logs (`docker logs … | grep -i 'local:\|data/blobs'` → empty).
- [ ] **Step 3: Commit** `docs: hospital self-service branding, vendor onboarding runbook; white-label verified`.
