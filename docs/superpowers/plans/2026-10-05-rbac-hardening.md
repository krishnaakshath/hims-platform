# RBAC Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every staff role (admin, crc, pi, frontdesk, pharmacy, billing, labs) reaches only the pages and APIs its job needs, with the gaps found in the 2026-10-05 audit closed and proved by red-to-green role-gate tests over all 7 roles plus a live role x route matrix.

**Architecture:** Keep the codebase's existing convention: an inline allowlist check right after `requireSession()` (API: `return NextResponse.json({ error: 'Forbidden' }, { status: 403 })`) or `requireSessionOrRedirect()` (page: `redirect('/')`), before any data fetch. The only new shared code is `src/lib/role-policy.ts`, a dependency-free module of named allowlists (plus `ALL_ROLES` and `searchScopesFor`) so the same set is not re-typed in 30 files. Both role-gate harnesses expand to all 7 roles and every dashboard page / gated route; rows whose fix lands in a later task carry a `gap: 'Tn'` tag that runs them as `it.fails`, so each task removes its tags and leaves the tree green.

**Tech Stack:** Next.js 16 App Router (read `node_modules/next/dist/docs/` before writing Next code; AGENTS.md), React 19, TypeScript, drizzle-orm + node-postgres on a shared Neon DB, Upstash Redis cache, Vitest 5 + Testing Library (jsdom).

**Spec:** `/private/tmp/claude-501/-Users-k2a/22ab088d-c88d-4494-827d-f0d45bf129fc/scratchpad/rbac/POLICY.md` (POLICY RULINGS + Definition of Done are binding). Intent sources: `src/lib/role-capabilities.ts`, `NAV_*` in `src/components/LeftNav.tsx`. Live-matrix scripts: `/private/tmp/claude-501/-Users-k2a/22ab088d-c88d-4494-827d-f0d45bf129fc/scratchpad/matrix/{probe.js,crawl.js,report.js,login.js}`.

## Global Constraints

- Work only in `/Users/k2a/Desktop/clinsync/.worktrees/rbac-hardening` (branch `feature/rbac-hardening`, base `hims-platform` 30fc2b5). Never touch the main checkout or other worktrees; `/Users/k2a/Desktop/clinsync/.env.local` is read-only (copy it, never edit it).
- Shared Neon DB: a test creates its own rows and deletes them by explicit id. NEVER broad deletes. NEVER delete `audit_log` rows broadly (by action string or by role) — before running an existing test file, `grep -n "delete(auditLog)"` it; if the delete is not keyed to an id or a test-only patient/document id, remove that cleanup in the same task (audit rows are append-only compliance records).
- Never run the full vitest suite (it hangs). Run per file: `npx dotenv -e .env.local -- npx vitest run <path>`. `tests/pages/page-gates-harness.ts` consumers and `tests/pages/nav-role-enforcement.test.tsx` are mocked/fast and may be run together.
- No schema changes, no migrations, no new npm dependencies.
- Additive behavior for allowed roles: front-desk registration (`AddClientModal` → POST /api/patients) and check-in, pharmacy patient lookup, the lab worklist (incl. imaging thumbnails), and every billing page must keep working. Every task adds a positive test for each allowed role it touches.
- API gate: the role check is the statement immediately after `if (session instanceof NextResponse) return session`; denied body is exactly `{ error: 'Forbidden' }` with status 403. Page gate: immediately after `const session = await requireSessionOrRedirect()`, before `await params`/`searchParams` and before any query. Unknown/future roles are denied because every check is an allowlist.
- `src/lib/role-policy.ts` must not import anything at runtime (only `import type`) — many tests `vi.mock('@/lib/auth')` with a partial factory, so role constants must never live in `auth.ts`.
- No "Tebra" or "IntakeQ" in new code, copy, or comments.
- Every UI change is verified against a real dev server with a minted staff cookie, and the actual command output is pasted into the task report (see "Dev-server verification protocol" below).
- Commits: one per task minimum, conventional-commit messages, `git add` only the files the task lists.

### Dev-server verification protocol (used by every UI task)

```bash
# terminal A (background, log kept for crash forensics)
npx dotenv -e .env.local -- npx next dev -p 3300 > /tmp/rbac-dev.log 2>&1
# mint a cookie for ROLE (userId null; for a pi flow that needs provider identity pass the seeded users.id instead)
COOKIE=$(ROLE=frontdesk npx dotenv -e .env.local -- npx tsx -e "import { buildSessionCookieValue } from './src/lib/auth'; buildSessionCookieValue(process.env.ROLE as any, 'Verify ' + process.env.ROLE, null).then((v) => console.log(v))")
curl -s -o /tmp/body.html -w '%{http_code} %{redirect_url}\n' -H "Cookie: clinsync_demo_session=$COOKIE" http://localhost:3300/<path>
grep -c "<RD-0001 surname>" /tmp/body.html   # denied pages/APIs must print 0
grep -o 'NEXT_REDIRECT;[a-z]*;[^;"\\]*' /tmp/body.html | head -1   # page gates show the target
```
Get RD-0001's surname once from an admin GET of `/api/patients/RD-0001/fhir/Patient`. Paste the status line, the grep counts and the redirect target for each role checked.

## Review Focus

1. **PHI in a denied response body.** Dashboard pages stream: a denied page returns 200 with the layout (TopBanner/LeftNav) and an RSC `NEXT_REDIRECT`. Expected: the page component's `redirect()` fires before any query, so no patient name/id appears in the body. Pinned by the harness's "never touches the database" test (getDb throws) for every denied role on every page, the API table's exact `{ error: 'Forbidden' }` body assertion, and the curl surname grep in each UI task.
2. **Front desk keeps registration and check-in, loses clinical evidence.** Expected: frontdesk still sees /patients (names, DOB, provider, Add Patient), the patient detail header, identity verification, portal panel and room transfer; never verdicts, criteria counts, discrepancies, chart summary or discharge clinical fields. Pinned in Task 2 (`patients-frontdesk-view.test.tsx`) and the dev-server walkthrough of /front-desk/check-in + registration.
3. **Billing pages still render patient names, without links, for billing.** Pinned in Task 9 (`billing-tables-patient-links.test.tsx`), plus admin/crc keep their links.
4. **Labs keeps its worklist after losing the chart.** Expected: /labs, /api/lab-orders, /api/labs/patients/[id] and imaging thumbnails (`/api/documents/[id]/download` for lab-order documents) keep working for labs; /patients/[id]/medical-record redirects labs to /labs. Pinned in Tasks 2 and 4.
5. **Global search for a role with no scope, and client components whose API now 403s.** Expected: pharmacy/billing/labs see no search box and /api/search 403s them; frontdesk gets patients only. Every newly gated route's `fetch` callers were enumerated (table in Task 1) and each is rendered only to allowed roles; each task re-greps its routes' callers before committing. Pinned in Task 10 and by the per-task caller grep step.

---

## Audit corrections (static audit vs. current code at 30fc2b5)

- NoteCard hydration: the `toLocaleString()` is in `src/components/NoteForm.tsx:146` (`NoteCard`, a client component), not `medical-record/page.tsx ~146`. `page.tsx:144` (`Chart data as of …`) is server-only — no hydration mismatch.
- `/api/charges` and `/api/charges/[id]`: only the two GETs are ungated; POST and PATCH already check `admin/crc/billing`.
- `/patients/[anonId]/medical-record` does not redirect pharmacy/frontdesk — it renders a "Chart access restricted" stub (no data fetch). Billing and labs get the full chart.
- `FrontDeskDashboard` is `src/components/dashboards/FrontDeskDashboard.tsx`; it links to `/staff` twice (lines 73 and 134).
- Stale copy also at `patients/[anonId]/page.tsx:85` ("click Refresh from Source Systems") besides the button (line 181) and "Dual-sourced" (line 64). Comments in `api/patients/[anonId]/screening/confirm/route.ts:9` and `lib/queries/pipeline-dashboard.ts:43` still cite the deleted refresh route.
- `webhooks/fhir-labs` cannot use `logAudit` (it requires a staff `Session`); the sanctioned session-less writer is `src/lib/patient-portal-audit.ts` (`role: null`). `LIS_INTEGRATION_TOKEN` and `GOOGLE_CLIENT_ID` are both absent from `.env.local`, and no `.env.example` exists (`.env*` is gitignored).
- Google OAuth: both `start` and `callback` return 500; `tests/api/auth-google.test.ts:9` pins the 500 and must change.
- Workbook export: `listPatientsWithStatus(null)` returns one row per screening, so a multi-trial patient triggers `getPatientDetail` (Redis get + ~9 sequential queries + Redis set) more than once; plus one `formSubmissions` query per row, all inside one unbounded `Promise.all`. Root cause of the dev-server death is still unproven (Task 13 proves it).
- Not in the audit (found by grepping every page/route):
  - `/telemedicine/[sessionId]/page.tsx` runs `getSessionById` (DB) **before** its role gate (line 17 vs 32).
  - `GET /api/trials` has no role gate.
  - `/billing` (index), `/patients/[anonId]`, `/patients/[anonId]/medical-record`, `/trials/[trialId]`, `/client-forms/[id]`, `/staff/[id]`, `/documents`, `/telemedicine/[sessionId]` are missing from `PAGE_GATES`; `/patients` and `/calendar` rows lack the `searchParams` prop their pages await.
  - `/api/documents/[id]/download` is the image source for `ImagingAttachmentStrip` inside `LabWorklist` — a plain admin/crc/pi/frontdesk gate would break labs.
  - Patient detail shows frontdesk the Form-vs-Chart discrepancies and, via `InpatientHistoryPanel`, discharge diagnosis/drugs/devices/diet/notes; `PatientQuickGlance` shows a criteria count.
  - Frontdesk cannot reach `InsuranceCardUpload` today (it renders only on the medical-record page, which stubs frontdesk).
  - Both harnesses' mocked sessions omit `userId`.
  - Existing tests delete `audit_log` rows broadly by action string (`trials`, `charges`, `form-templates`, `fhir-export-routes`, `broadcasts`, `reviews`, `users`, `consent-documents`).
- Matrix `probe.js` expectations that differ from POLICY.md (fixed in Task 14): medical-record (labs allowed → should be `redir:/labs`; pharmacy/frontdesk `stub` → deny), `/staff` + `/staff/[id]` (add pi), FHIR `Patient` (drop frontdesk), insurance-card (add pi), criteria PUT (crc → only pi/admin), identity PUT (add crc), form-submissions POST/PUT (add pi), documents download (add labs-for-lab-docs note), plus missing rows for discrepancy resolve, insurance-card `back`, and the webhook 503.

## Rulings beyond POLICY.md (need human confirmation)

1. **GET /api/patients and GET /api/patients/[anonId] deny frontdesk** (admin/crc/pi only). No client component calls either GET; the frontdesk view is rendered server-side from query functions, so a reduced API shape would be dead code.
2. **Frontdesk patient detail (reduced view):** header (avatar, name, id, DOB), Identity Verification, Patient Portal Access panel (its existing non-admin rendering), Inpatient History with `canTransfer` but the five discharge clinical fields nulled. No Screening tab, Overview/chart summary, discrepancies, QuickGlance, status chip or eligibility text. **Insurance-card upload is NOT added** for frontdesk (new feature; `role-capabilities.ts` says insurance is billing's domain) — `POST /api/patients/[anonId]/insurance-card` keeps allowing frontdesk.
3. **Medical record denied roles redirect** (frontdesk, pharmacy, billing → `/`; labs → `/labs`), replacing the two friendly stubs, so the harness and matrix see one uniform gate.
4. **Labs may download a document only when `documents.labOrderId` is non-null** (imaging attachments); any other document 403s for labs.
5. **Billing tables:** names are plain text for the `billing` role only; admin/crc keep their `/patients/[id]` links.
6. **GET /api/trials** gated to admin/crc/pi (falls under the trials ruling; no client callers).
7. **Left unchanged, flagged:** `GET /api/staff*` still allows frontdesk (`READ_ROLES`, pinned by `staff-directory.test.ts`); `GET /api/inpatient/admissions/[id]/medications` allows frontdesk (MAR data; UI only opens it for pi/admin); `/prescriptions/print` allows frontdesk; broad audit deletes in test files this plan does not run.
8. **Webhook rejections are audited** (role null) as POLICY says; this is an unauthenticated DB write per bad request — consider a rate limit later.
9. **`role-capabilities.ts` labs bullet** ("View the medical record's Lab Results and Imaging sections") is rewritten to match ruling 3's labs redirect.

---

## Controller rulings (binding; supersede the planner's open questions)

- Rulings 1–6 and 9 above are CONFIRMED as written.
- Ruling 7 (left unchanged): `GET /api/staff*` and `/prescriptions/print` stay as they are. `GET /api/inpatient/admissions/[id]/medications` is NOT left open: gate it to `['admin','crc','pi']` (medication administration data is clinical; the UI only opens it for pi/admin) — fold this into Task 3 with a harness row and a denial test.
- Ruling 8 (webhook audit): do NOT write a DB row for REJECTED webhook calls (an unauthenticated caller must not be able to trigger DB writes); log rejects with `console.warn` (no token/payload content) and write the session-less audit row only for ACCEPTED calls. Update Task 11's tests accordingly.
- Task ORDER: execute Tasks 1–13, then Tasks 15–19 (below), and Task 14 LAST (it is the final green/matrix/docs task and must cover 15–17's harness rows).

## File structure

| File | Responsibility |
|---|---|
| `src/lib/role-policy.ts` (new) | `ALL_ROLES`, named allowlists, `searchScopesFor(role)`. No runtime imports. |
| `src/lib/auth.ts` | `VALID_ROLES` becomes `ALL_ROLES`. |
| `tests/pages/page-gates-harness.ts` | 7 roles, every dashboard page, `deniedRedirect`, `gap`. |
| `tests/pages/nav-role-enforcement.test.tsx` | gap-aware runner, page-file coverage test, nav gap map. |
| `tests/api/rbac-route-gates.test.ts` | 7 roles, `API_GATES` table, gap-aware runner. |
| `src/components/LocalDateTime.tsx` (new) | hydration-safe local date/time text. |
| `src/lib/concurrency.ts` (new, Task 13 if evidence supports) | `mapWithConcurrency`. |
| Page/route files | one-line gates per task. |

---

### Task 1: Setup, `role-policy.ts`, and red harnesses over all 7 roles

**Files:**
- Create: `src/lib/role-policy.ts`
- Modify: `src/lib/auth.ts:8` (VALID_ROLES)
- Modify: `tests/pages/page-gates-harness.ts`, `tests/pages/nav-role-enforcement.test.tsx`, `tests/api/rbac-route-gates.test.ts`

**Interfaces:**
- Produces (`src/lib/role-policy.ts`, all `readonly Role[]` unless noted):
  - `ALL_ROLES = ['crc','pi','admin','frontdesk','pharmacy','billing','labs'] as const` plus a compile-time check that `Exclude<Role, (typeof ALL_ROLES)[number]>` is `never`
  - `CLINICAL_ROLES = ['admin','crc','pi']` — chart, patient JSON APIs, FHIR/C-CDA, trials pages + GET, client forms, form-submissions, form-templates, discrepancy resolve, staff directory pages
  - `PATIENT_DIRECTORY_ROLES = ['admin','crc','pi','frontdesk']` — /patients list + detail pages
  - `SCHEDULING_ROLES = ['admin','crc','pi','frontdesk']` — /calendar + /api/appointments*
  - `DOCUMENT_READ_ROLES = ['admin','crc','pi','frontdesk']`
  - `INSURANCE_CARD_READ_ROLES = ['admin','crc','pi','frontdesk','billing']`
  - `IDENTITY_VERIFY_ROLES = ['admin','crc','frontdesk']`
  - `TRIAL_CRITERIA_EDIT_ROLES = ['admin','pi']`
  - `CHARGES_ROLES = ['admin','crc','billing']`
  - `type SearchScopes = { patients: boolean; trials: boolean; formTemplates: boolean }`; `searchScopesFor(role: Role): SearchScopes` (patients ⇔ PATIENT_DIRECTORY_ROLES; trials, formTemplates ⇔ CLINICAL_ROLES; any other role → all false); `hasSearchScope(role: Role): boolean`
- Produces (harness): `PageGateCase` gains `deniedRedirect?: Partial<Record<Role, string>>` and `gap?: string`; `ALL_ROLES` re-exported from role-policy; `gateIt(c: { gap?: string })` returns `it.fails` when `c.gap && !process.env.RBAC_SHOW_GAPS`, else `it`. API harness: `ApiGateCase = { name: string; call: () => Promise<Response>; allowed: Role[]; gap?: string }`, exported `API_GATES`.

- [ ] **Step 1: Setup the worktree**

```bash
cd /Users/k2a/Desktop/clinsync/.worktrees/rbac-hardening
cp /Users/k2a/Desktop/clinsync/.env.local .env.local
npm ci --ignore-scripts
git status --short   # .env.local must NOT appear (gitignored)
```

- [ ] **Step 2: Write `src/lib/role-policy.ts`** with the exports above; point `auth.ts`'s `VALID_ROLES` at `ALL_ROLES`. Run `npx tsc --noEmit -p .` → no new errors.

- [ ] **Step 3: Expand the page harness.** `ALL_ROLES` from role-policy; runPage's mocked session becomes `{ role, name: \`Test ${role}\`, userId: null }`; `/patients` and `/calendar` rows get `props: { searchParams: Promise.resolve({}) }`; replace the `/documents` "no row" comment. Rows to add/change (allowed set from POLICY.md, gap = closing task):

| route | allowed | deniedRedirect | gap |
|---|---|---|---|
| `/patients` | admin, crc, pi, frontdesk | | T2 |
| `/patients/[anonId]` (params `RD-0001`) | admin, crc, pi, frontdesk | | T2 |
| `/patients/[anonId]/medical-record` | admin, crc, pi | `{ labs: '/labs' }` | T2 |
| `/documents` | admin, crc, pi, frontdesk | | T4 |
| `/trials/[trialId]` (params `nct-adhd-demo-01`) | admin, crc, pi | | T5 |
| `/client-forms/[id]` (params `1`) | admin, crc, pi | | T6 |
| `/calendar` | admin, crc, pi, frontdesk | | T7 |
| `/telemedicine/[sessionId]` (params `1`) | admin, pi | | T7 |
| `/staff` | admin, crc, pi | | T8 |
| `/staff/[id]` (params `1`) | admin, crc, pi | | T8 |
| `/billing` | admin, crc, billing | | — |

- [ ] **Step 4: Update `nav-role-enforcement.test.tsx`.** Both page tests use `gateIt(c)`; the redirect assertion becomes `toHaveBeenCalledWith(c.deniedRedirect?.[role] ?? '/')`. Add `NAV_GAPS: Record<string, string> = { '/documents': 'T4', '/staff': 'T8' }` used by the nav-equality `it.each` the same way. Add:

```ts
it('every (dashboard) page file has a PAGE_GATES row or an explicit exemption', () => {
  const EXEMPT = ['/', '/reports'] // '/' = per-role landing (dashboard-routing.test.tsx); '/reports' = bare redirect
  const routes = globSync('src/app/(dashboard)/**/page.tsx').map(toRoute) // fs walk; '(dashboard)/x/[id]/page.tsx' -> '/x/[id]'
  expect(routes.filter((r) => !EXEMPT.includes(r) && !PAGE_GATES.some((g) => g.route === r))).toEqual([])
})
```

- [ ] **Step 5: Expand the API harness.** `ALL_ROLES` from role-policy (delete the local roster); mocked session gains `userId: null`; add `vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))`; existing "403s pi and frontdesk" blocks keep `deniedFor` (now 7 roles). Add `API_GATES` and one generic block:

```ts
describe.each(API_GATES)('$name', (c) => {
  gateIt(c)('403s every role outside the policy with no data in the body, and admits every allowed role', async () => {
    for (const role of ALL_ROLES) {
      sessionRole = role
      const res = await c.call()
      if (c.allowed.includes(role)) expect(res.status, `${c.name} must admit ${role}`).not.toBe(403)
      else { expect(res.status, `${c.name} must deny ${role}`).toBe(403); expect(await res.json()).toEqual({ error: 'Forbidden' }) }
    }
  })
})
```

Rows (allowed calls use bogus ids `2147483000` / `RD-ZZZZ` / `probe-no-trial` or `{}` bodies so nothing is written):

| name | call | allowed | gap |
|---|---|---|---|
| GET /api/patients | list | CLINICAL | T3 |
| GET /api/patients/[anonId] | RD-ZZZZ | CLINICAL | T3 |
| GET ccda + 7× GET fhir/{AllergyIntolerance,Bundle,Condition,MedicationDispense,MedicationRequest,Observation,Patient} | RD-ZZZZ | CLINICAL | T3 |
| PUT /api/patients/[anonId]/identity | RD-ZZZZ, `{}` | IDENTITY_VERIFY | T3 |
| GET /api/patients/[anonId]/insurance-card/[side] | RD-ZZZZ, front | INSURANCE_CARD_READ | T3 |
| POST /api/discrepancies/[id]/resolve | 2147483000 | CLINICAL | T3 |
| GET /api/documents/[id]/download | 2147483000 | DOCUMENT_READ + labs (lab-doc rule tested in Task 4) | T4 |
| GET /api/trials | list | CLINICAL | T5 |
| PUT /api/trials/[trialId]/criteria | probe-no-trial, `{}` | TRIAL_CRITERIA_EDIT | T5 |
| GET, POST /api/form-submissions; GET, PUT /api/form-submissions/[id] | `{}` / 2147483000 | CLINICAL | T6 |
| GET, POST /api/form-templates; GET, PUT /api/form-templates/[id] | `{}` / 2147483000 | CLINICAL | T6 |
| GET /api/appointments (no from/to → 400), POST `{}`, PUT /api/appointments/[id] `{}` | | SCHEDULING | T7 |
| GET /api/charges; GET /api/charges/[id] | 2147483000 | CHARGES | T9 |
| GET /api/search?q= | | admin, crc, pi, frontdesk | T10 |

- [ ] **Step 6: Capture the red list (the evidence).**

```bash
RBAC_SHOW_GAPS=1 npx dotenv -e .env.local -- npx vitest run tests/pages/nav-role-enforcement.test.tsx 2>&1 | tee /tmp/rbac-red-pages.txt | grep -E "FAIL|✗|×" 
RBAC_SHOW_GAPS=1 npx dotenv -e .env.local -- npx vitest run tests/api/rbac-route-gates.test.ts 2>&1 | tee /tmp/rbac-red-api.txt | grep -E "FAIL|✗|×"
```
Expected red (paste the actual list into the task report; any difference is a finding to report, not to paper over): pages `/patients`, `/patients/[anonId]` (pharmacy, billing, labs admitted), medical-record (frontdesk, pharmacy, billing not redirected; labs not sent to /labs), `/documents`, `/calendar` (pharmacy, billing, labs), `/trials/[trialId]`, `/client-forms/[id]`, `/staff/[id]` (frontdesk…labs admitted), `/staff` (pi bounced), `/telemedicine/[sessionId]` (DB touched before denying crc/frontdesk/pharmacy/billing/labs), nav equality `/documents`, `/staff`; every API row above.

- [ ] **Step 7: Run without the flag → green.** Same two commands without `RBAC_SHOW_GAPS`. Expected: all pass (gap rows pass as `it.fails`). `/billing` row passes normally.

- [ ] **Step 8: Commit** — `test(rbac): expand page and API role-gate harnesses to all 7 roles with gap-tagged known failures` (files: role-policy.ts, auth.ts, the three test files).

---

### Task 2: Patient pages — list, detail (frontdesk reduced view), medical record

**Files:**
- Modify: `src/app/(dashboard)/patients/page.tsx`, `src/app/(dashboard)/patients/[anonId]/page.tsx`, `src/app/(dashboard)/patients/[anonId]/medical-record/page.tsx`, `src/components/PatientsTable.tsx`, `src/lib/role-capabilities.ts` (labs bullet)
- Delete: `src/components/RefreshEligibilityButton.tsx`
- Modify comments: `src/app/api/patients/[anonId]/screening/confirm/route.ts:9`, `src/lib/queries/pipeline-dashboard.ts:43`, `src/components/DiscrepancyList.tsx:27`
- Test: `tests/pages/patients-frontdesk-view.test.tsx` (new), harness gap tags `T2` removed, `tests/pages/patient-detail-inpatient-tab.test.tsx` + `tests/pages/pi-chart-access.test.tsx` (add `redirect` to their `next/navigation` mocks; fix the stale medical-record `allowed`)

**Interfaces:**
- Consumes: `PATIENT_DIRECTORY_ROLES`, `CLINICAL_ROLES` from Task 1.
- Produces: `PatientsTable({ patients, showMedicalRecordLink = true, showScreening = true })` — `showScreening=false` omits StatusChip, CriteriaReadout and the status accent stripe.

- [ ] **Step 1: Write failing tests** in `tests/pages/patients-frontdesk-view.test.tsx` (mock `@/lib/queries/patients` with one row `{ id:'RD-T1', name:'Pat Frontdesk', overallStatus:'red', criteriaSummary:{inclusionMet:2,inclusionTotal:3,exclusionMet:1,exclusionTotal:1}, … }` twice with two trialIds; detail stub with `criteria:[1 item]`, `discrepancies:[1 item]`, `overallStatus:'green'`, one discharged admission with `dischargeDiagnosis:'DX-SECRET'`):
  - `frontdesk /patients shows each patient once with no verdict or criteria text` → `queryByText('Potential Exclusion')`, `/inclusion/`, `/exclusion/` absent; `getAllByText('Pat Frontdesk')` length 1; no trial filter link text.
  - `admin /patients still shows verdicts` → `getByText('Potential Exclusion')`.
  - `frontdesk patient detail hides screening, discrepancies, quick glance and discharge clinical text` → no `Screening` tab, no `Form vs. Chart Discrepancies`, no `Criteria evaluated`, no `Meets`, no `DX-SECRET`; `getByText('Identity Verification')` present; `Inpatient History` tab present.
  - `no role sees Refresh from Source Systems or Dual-sourced copy` → for admin and frontdesk, `queryByText(/Refresh from Source Systems/)` and `/Dual-sourced/` absent.
  - `frontdesk keeps the Add Patient button on /patients` → button present.
- [ ] **Step 2: Run** `npx dotenv -e .env.local -- npx vitest run tests/pages/patients-frontdesk-view.test.tsx` → FAIL on verdict/discrepancy/refresh assertions.
- [ ] **Step 3: Implement.**
  - `/patients`: gate `PATIENT_DIRECTORY_ROLES`; for frontdesk skip `listAllTrials`, ignore `trialId`, dedupe rows by `id`, omit `overallStatus`/`criteriaSummary` from the projected props, hide the trial tab bar, pass `showScreening={false}`.
  - `/patients/[anonId]`: gate `PATIENT_DIRECTORY_ROLES`; delete the `RefreshEligibilityButton` import/render and the component file; Overview copy becomes "Diagnoses, medications, and allergies live on this patient's Medical Record page."; Screening empty state becomes "No screening evidence yet." For frontdesk render the reduced view of ruling 2 (inpatient admissions mapped with `dischargeDiagnosis/Drugs/Devices/Diet/SummaryNotes: null`).
  - medical-record: replace both stubs with `if (session.role === 'labs') redirect('/labs')` then `if (!CLINICAL_ROLES.includes(session.role)) redirect('/')`, both before `await params`.
  - `role-capabilities.ts` labs bullet → "View lab results and imaging for every ordered test from the Lab worklist (no chart access)".
- [ ] **Step 4: Remove `gap: 'T2'`** from the three PAGE_GATES rows. Run `npx dotenv -e .env.local -- npx vitest run tests/pages/nav-role-enforcement.test.tsx tests/pages/patients-frontdesk-view.test.tsx tests/pages/patient-detail-inpatient-tab.test.tsx tests/pages/pi-chart-access.test.tsx tests/components/PatientsTable.test.tsx` → PASS.
- [ ] **Step 5: Caller check.** `grep -rn "RefreshEligibilityButton\|/refresh'" src` → no hits; `grep -rn "medical-record" src/components src/app` → every link is rendered only for CLINICAL roles (PatientsTable `showMedicalRecordLink` already false for frontdesk; confirm no labs/billing surface links to it).
- [ ] **Step 6: Dev-server verification.** Per protocol: `/patients` and `/patients/RD-0001` for frontdesk (200, surname present, `grep -c "Potential Exclusion\|Needs Verification\|Meets"` = 0), pharmacy/billing/labs (redirect to `/`, surname count 0); `/patients/RD-0001/medical-record` for labs (`NEXT_REDIRECT…/labs`), frontdesk/billing/pharmacy (`/`), pi (200). Frontdesk walkthrough: open /front-desk/check-in and the Add Patient modal (200, no error markers).
- [ ] **Step 7: Commit** — `fix(rbac): gate patient pages, add frontdesk reduced view, redirect labs from the chart`.

---

### Task 3: Patient APIs — list/detail, FHIR/C-CDA, identity, insurance-card image, discrepancy resolve

**Files:**
- Modify: `src/app/api/patients/route.ts` (GET), `src/app/api/patients/[anonId]/route.ts` (GET), `src/app/api/patients/[anonId]/ccda/route.ts`, the 7 `src/app/api/patients/[anonId]/fhir/*/route.ts`, `src/app/api/patients/[anonId]/identity/route.ts`, `src/app/api/patients/[anonId]/insurance-card/[side]/route.ts`, `src/app/api/discrepancies/[id]/resolve/route.ts`
- Test: `tests/api/rbac-route-gates.test.ts` (remove `T3`), `tests/api/patients.test.ts` (GET describes use `mockResolvedValue({ role: 'crc', … userId: null })` in a `beforeEach`; add "403s frontdesk on GET list and detail"), `tests/api/fhir-export-routes.test.ts` (add "403s frontdesk on all 8 routes"; remove its broad `afterAll` audit delete), `tests/api/identity-verification.test.ts` (add "403s pi, pharmacy, billing, labs")

**Interfaces:**
- Consumes: `CLINICAL_ROLES`, `IDENTITY_VERIFY_ROLES`, `INSURANCE_CARD_READ_ROLES`.

- [ ] **Step 1: Write the per-file failing tests** named above (each asserts 403 + `{ error: 'Forbidden' }` for the denied role and a non-403 for one allowed role).
- [ ] **Step 2: Run** `npx dotenv -e .env.local -- npx vitest run tests/api/patients.test.ts` (and the other three) → new tests FAIL.
- [ ] **Step 3: Implement** the inline gates (ccda/fhir: replace `['admin','pi','crc','frontdesk']` with `CLINICAL_ROLES`).
- [ ] **Step 4: Remove `gap: 'T3'`**; run `tests/api/rbac-route-gates.test.ts`, `patients.test.ts`, `fhir-export-routes.test.ts`, `identity-verification.test.ts`, `patients-insurance-card-image.test.ts`, `patients-create.test.ts` one by one → PASS (patients-create proves frontdesk registration still works).
- [ ] **Step 5: Caller check.** `grep -rn "fetch(\`/api/patients\|'/api/patients'\|/api/discrepancies\|insurance-card/\|/fhir/\|/ccda" src --include=*.tsx` → callers are `AddClientModal` (POST, unchanged), `DiscrepancyList` (now only on the non-frontdesk detail view), medical-record page links/images (CLINICAL only). Paste the grep.
- [ ] **Step 6: Dev-server verification.** `curl` as frontdesk: `/api/patients/RD-0001/fhir/Bundle` → 403 body `{"error":"Forbidden"}`; as crc → 200; `/api/patients/RD-0001/insurance-card/front` as billing → not 403; as labs → 403.
- [ ] **Step 7: Commit** — `fix(rbac): gate patient JSON, FHIR/C-CDA, identity, insurance-card and discrepancy routes`.

---

### Task 4: Documents — page gate, nav entry, download route (labs lab-order exception)

**Files:**
- Modify: `src/app/(dashboard)/documents/page.tsx`, `src/components/LeftNav.tsx:61` (Documents roles → `['admin','crc','pi','frontdesk']`), `src/app/api/documents/[id]/download/route.ts` (replace the "No role gate" comment)
- Test: `tests/api/documents-download.test.ts` (widen `sessionRole` type; add cases; remove the `delete(auditLog)` only if it is not keyed to the test's own document id — it is keyed, so keep it), harness gaps `T4` (page row, nav gap, API row), `tests/components/LeftNav.test.tsx`

- [ ] **Step 1: Failing tests** in `documents-download.test.ts`: `403s billing and pharmacy` (Forbidden body, `get` from `@vercel/blob` not called); `admits labs for a document attached to a lab order` (insert a document row with `labOrderId` of an existing lab order created by the test, delete by id after); `403s labs for a document with no lab order`; `still streams for frontdesk and pi`. LeftNav test: `shows Documents to pi and frontdesk, not to pharmacy, billing or labs`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Page: `if (!DOCUMENT_READ_ROLES.includes(session.role)) redirect('/')`. Download: immediately after session, `if (!DOCUMENT_READ_ROLES.includes(session.role) && session.role !== 'labs') return 403`; after `getDocument`, `if (session.role === 'labs' && existing.labOrderId === null) return 403` (before the blob fetch and audit).
- [ ] **Step 4: Remove gaps `T4`**; run `nav-role-enforcement.test.tsx`, `rbac-route-gates.test.ts`, `documents-download.test.ts`, `LeftNav.test.tsx`, `tests/pages/lab-worklist-imaging.test.tsx` → PASS.
- [ ] **Step 5: Dev-server verification.** `/documents` as pi and frontdesk (200, nav shows Documents), as billing (`/`); as labs open `/labs` and confirm an imaging thumbnail URL from the worklist returns 200 (`curl -o /dev/null -w '%{http_code}'`).
- [ ] **Step 6: Commit** — `fix(rbac): gate documents page/download and show Documents nav to pi and frontdesk`.

---

### Task 5: Trials — detail page, criteria PUT (pi/admin, 404, age range), GET /api/trials

**Files:**
- Modify: `src/app/(dashboard)/trials/[trialId]/page.tsx`, `src/app/api/trials/[trialId]/criteria/route.ts`, `src/app/api/trials/route.ts`
- Test: `tests/api/trials.test.ts` (criteria tests switch to pi; remove the broad `afterAll` audit delete at line 22), harness gaps `T5`

- [ ] **Step 1: Failing tests** in `trials.test.ts`: `criteria PUT 403s crc and frontdesk`; `criteria PUT returns 404 for an unknown trial` (`probe-no-trial`, body `{ ageMin: 18 }`); `criteria PUT rejects ageMax below ageMin` (`{ ageMin: 40, ageMax: 30 }` → 400); `criteria PUT rejects an ageMax below the stored ageMin` (read the seeded row's `ageMin`, send `{ ageMax: ageMin - 1 }` → 400); `criteria PUT returns 400 for an empty body` (`{}`); `GET /api/trials 403s frontdesk`. Keep the existing snapshot/restore of `nct-adhd-demo-01`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Criteria: gate `TRIAL_CRITERIA_EDIT_ROLES`; after parse, 400 `{ error: 'No criteria fields to update' }` when the object is empty; load the trial by id (404 `{ error: 'Not found' }`); effective `min = parsed.ageMin ?? trial.ageMin`, `max = parsed.ageMax ?? trial.ageMax`; 400 `{ error: 'ageMax must be greater than or equal to ageMin' }` when `max < min`. Page and GET: `CLINICAL_ROLES`.
- [ ] **Step 4: Remove gaps `T5`**; run `trials.test.ts`, `rbac-route-gates.test.ts`, `nav-role-enforcement.test.tsx` → PASS.
- [ ] **Step 5: Dev-server verification.** `/trials/nct-adhd-demo-01` as frontdesk (`/`) and pi (200); `curl -X PUT` criteria as crc → 403.
- [ ] **Step 6: Commit** — `fix(rbac): gate trial detail and trial APIs; validate criteria updates`.

---

### Task 6: Client forms page, form-submissions API, form-templates API

**Files:**
- Modify: `src/app/(dashboard)/client-forms/[id]/page.tsx`, `src/app/api/form-submissions/route.ts`, `src/app/api/form-submissions/[id]/route.ts`, `src/app/api/form-templates/route.ts`, `src/app/api/form-templates/[id]/route.ts`
- Test: `tests/api/form-submissions.test.ts`, `tests/api/form-templates.test.ts` (remove its broad audit delete at line 35), harness gaps `T6`

- [ ] **Step 1: Failing tests:** `form-submissions: 403s frontdesk on GET list, POST, GET by id, PUT` and `admits pi on GET by id` (existing seeded submission id from `select … limit 1`); `form-templates: 403s frontdesk and pharmacy on all four handlers`, `admits pi on GET list`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `CLINICAL_ROLES` gates (page before `await params`).
- [ ] **Step 4: Remove gaps `T6`**; run `form-submissions.test.ts`, `form-submissions-send-atomic.test.ts`, `form-submission-answer-visibility.test.ts`, `form-templates.test.ts`, `rbac-route-gates.test.ts`, `nav-role-enforcement.test.tsx` → PASS.
- [ ] **Step 5: Caller check.** `SendFormModal` renders in `forms/[templateId]` (CLINICAL) and `DashboardHomeClient` (admin/crc home only); template editors render under `/forms*` (CLINICAL). Paste the grep.
- [ ] **Step 6: Dev-server verification.** `/client-forms/<seeded id>` as frontdesk (`/`), pi (200); send-form modal on admin home opens and lists templates.
- [ ] **Step 7: Commit** — `fix(rbac): gate client-form detail, form-submission and form-template APIs`.

---

### Task 7: Scheduling — calendar page, appointments API, telemedicine page gate ordering

**Files:**
- Modify: `src/app/(dashboard)/calendar/page.tsx`, `src/app/api/appointments/route.ts`, `src/app/api/appointments/[id]/route.ts`, `src/app/(dashboard)/telemedicine/[sessionId]/page.tsx`
- Test: `tests/api/appointments.test.ts`, `tests/pages/calendar.test.tsx`, `tests/pages/telemedicine-call-screen.test.tsx`, harness gaps `T7`

- [ ] **Step 1: Failing tests:** `appointments: 403s pharmacy, billing, labs on GET, POST, PUT`; `admits frontdesk on GET with a valid range` (200); telemedicine: `denied roles redirect without loading the telemedicine session` (spy on `getSessionById` mock: not called for crc).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `SCHEDULING_ROLES` gates; in the telemedicine page move `if (!['admin','pi'].includes(session.role)) redirect('/')` above `await params` / `getSessionById` (the pi ownership check stays after the lookup).
- [ ] **Step 4: Remove gaps `T7`**; run the three test files + `rbac-route-gates.test.ts` + `nav-role-enforcement.test.tsx` → PASS.
- [ ] **Step 5: Dev-server verification.** `/calendar` as frontdesk (200; change an appointment status via the select → PUT 200 in `/tmp/rbac-dev.log`), as labs (`/`).
- [ ] **Step 6: Commit** — `fix(rbac): gate calendar and appointments; gate telemedicine before loading the session`.

---

### Task 8: Staff directory pages, Staff nav for pi, front-desk dashboard links

**Files:**
- Modify: `src/app/(dashboard)/staff/page.tsx:16`, `src/app/(dashboard)/staff/[id]/page.tsx`, `src/components/LeftNav.tsx` (`/staff` roles → `['crc','admin','pi']`; update the header comment), `src/components/dashboards/FrontDeskDashboard.tsx` (`MiniStatTile.href` optional → renders a non-link `div` with the same classes when absent; tile at line 73 and the list rows at line 134 render without a link)
- Test: `tests/components/dashboards/FrontDeskDashboard.test.tsx` (new or extend existing dashboards tests), `tests/components/LeftNav.test.tsx`, harness gaps `T8` (two page rows + nav gap)

- [ ] **Step 1: Failing tests:** `FrontDeskDashboard renders the credentials tile and rows with no link to /staff` (`container.querySelector('a[href="/staff"]')` is null; text `Credentials Expiring` present); `LeftNav shows Staff to pi`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** gates (`CLINICAL_ROLES`, before `await params`) and the dashboard/nav edits; `canWrite` stays admin-only.
- [ ] **Step 4: Remove gaps `T8`**; run the two component tests, `nav-role-enforcement.test.tsx`, `tests/pages/dashboard-routing.test.tsx` → PASS.
- [ ] **Step 5: Dev-server verification.** `/staff` and `/staff/<seeded id>` as pi (200, no edit buttons) and frontdesk (`/`); frontdesk home `grep -c 'href="/staff"'` = 0.
- [ ] **Step 6: Commit** — `fix(rbac): open staff directory to pi, gate staff detail, drop front-desk /staff links`.

---

### Task 9: Charges API reads and billing-table patient links

**Files:**
- Modify: `src/app/api/charges/route.ts` (GET), `src/app/api/charges/[id]/route.ts` (GET), `src/components/PatientCollectionsTable.tsx:61`, `src/components/PatientStatementsTable.tsx:96`, `src/components/InsuranceClaimsTable.tsx:130`, the three billing pages that render them (pass `linkPatients={session.role !== 'billing'}`)
- Test: `tests/api/charges.test.ts` (remove broad audit delete at line 26), `tests/components/billing-tables-patient-links.test.tsx` (new), harness gaps `T9`

**Interfaces:**
- Produces: each of the three tables takes `linkPatients?: boolean` (default `true`); `false` renders the same text in a `<span className="font-medium text-foreground">`.

- [ ] **Step 1: Failing tests:** `GET /api/charges 403s pi, frontdesk, pharmacy, labs`; `GET /api/charges/[id] 403s labs`; for each table, `linkPatients={false} renders the patient name with no /patients link` and `default keeps the link`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `CHARGES_ROLES` GET gates and the prop.
- [ ] **Step 4: Remove gaps `T9`**; run `charges.test.ts`, the new component test, `rbac-route-gates.test.ts` → PASS.
- [ ] **Step 5: Dev-server verification.** As billing: `/billing/patient-collections`, `/billing/statements`, `/billing/insurance-collections` → 200, `grep -c 'href="/patients/'` = 0, surname count > 0; as crc the same pages show links.
- [ ] **Step 6: Commit** — `fix(rbac): gate charge reads; billing tables show patient names without chart links`.

---

### Task 10: Global search — UI visibility and API scoping

**Files:**
- Modify: `src/lib/queries/search.ts` (`searchAll(rawQuery: string, scopes: SearchScopes): Promise<SearchResults>` — skip loading a disallowed list entirely, return `[]` for it), `src/app/api/search/route.ts`, `src/components/TopBanner.tsx` (`{hasSearchScope(role) && <GlobalSearch />}`)
- Test: `tests/lib/queries/search.test.ts` (pass all-true scopes; add a scoped case), `tests/api/search.test.ts` (new), `tests/components/TopBanner.test.tsx`, harness gap `T10`

- [ ] **Step 1: Failing tests:** `searchAll with only patients scope never loads trials or templates` (spy on mocked `listAllTrials` / `listFormTemplates`: not called); `GET /api/search 403s pharmacy, billing, labs`; `GET /api/search for frontdesk returns patients and empty trials/formTemplates` (q=`RD-0001`); `TopBanner hides the search box for billing, pharmacy and labs` (`queryByRole('textbox')` null) and `shows it for frontdesk`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Route: `if (!hasSearchScope(session.role)) return 403` right after the session; `searchAll(q, searchScopesFor(session.role))`.
- [ ] **Step 4: Remove gap `T10`**; run the four test files + `rbac-route-gates.test.ts` → PASS.
- [ ] **Step 5: Dev-server verification.** `curl /api/search?q=<surname>` as frontdesk (patients only), billing (403); billing home HTML has no search input.
- [ ] **Step 6: Commit** — `fix(rbac): scope global search by role and hide it from roles without a scope`.

---

### Task 11: Integration endpoints — fhir-labs webhook fail-closed, Google OAuth 503

**Files:**
- Modify: `src/app/api/webhooks/fhir-labs/route.ts`, `src/lib/patient-portal-audit.ts` (add the second sanctioned session-less writer; update its header comment), `src/app/api/auth/google/start/route.ts`, `src/app/api/auth/google/callback/route.ts`, `README.md` (Run & operate: `LIS_INTEGRATION_TOKEN` — required to accept LIS results; unset ⇒ webhook returns 503)
- Test: `tests/api/webhooks-fhir-labs.test.ts` (new, fully mocked: `@/lib/patient-portal-audit` and `@/lib/queries/lab-orders`), `tests/api/auth-google.test.ts`

**Interfaces:**
- Produces: `logIntegrationEvent(action: string, patientId: string | null, details?: string): Promise<void>` — inserts `audit_log` with `userName: 'LIS integration'`, `role: null`.

- [ ] **Step 1: Failing tests** (`process.env.LIS_INTEGRATION_TOKEN` set/unset per test and restored):
  - `returns 503 JSON and never calls enterResult when LIS_INTEGRATION_TOKEN is unset` (also with header `Bearer test-hl7-token`).
  - `returns 401 for a missing or wrong bearer token and records a rejected integration event` (`logIntegrationEvent` called with `'rejected LIS lab result webhook'`, `null`, details containing `invalid token`; never with the token value).
  - `rejects a token that differs only in length` (`Bearer <token>x` → 401).
  - `accepts the correct token, enters the result and records an accepted event with the patient id` (enterResult mock returns `{ ok: true, patientId: 'RD-T' }`; action `'accepted LIS lab result for order 7'`).
  - Google: `start returns 503 when GOOGLE_CLIENT_ID is unset`; `callback returns 503 when GOOGLE_CLIENT_SECRET is unset`.
- [ ] **Step 2: Run** `npx dotenv -e .env.local -- npx vitest run tests/api/webhooks-fhir-labs.test.ts` and `tests/api/auth-google.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Webhook: read the env token at request time; unset → 503 `{ error: 'LIS integration is not configured' }`; compare `sha256(expected)` vs `sha256(supplied)` with `timingSafeEqual` (equal-length digests, no length leak); log rejections (no token material) and accepted results; drop the `'test-hl7-token'` fallback and the commented-out `logAudit`. `enterResult` returns `{ ok: true, patientId }` (lab-orders.ts:21) — pass that patientId to the accepted event. Google: both 500s → 503, same message.
- [ ] **Step 4: Run** both files → PASS. `grep -rn "test-hl7-token" src tests` → only the new test's negative case.
- [ ] **Step 5: Dev-server verification.** `curl -X POST /api/webhooks/fhir-labs -H 'Authorization: Bearer test-hl7-token'` → 503; `curl -i /api/auth/google/start` → 503.
- [ ] **Step 6: Commit** — `fix(security): fail the LIS webhook closed, compare tokens in constant time, audit it; 503 for unconfigured Google sign-in`.

---

### Task 12: NoteCard hydration mismatch

**Files:**
- Create: `src/components/LocalDateTime.tsx`
- Modify: `src/components/NoteForm.tsx:146`
- Test: `tests/components/LocalDateTime.test.tsx` (new)

**Interfaces:**
- Produces: `LocalDateTime({ iso, className? }: { iso: string; className?: string })` — client component; renders `<time dateTime={iso}>` whose text is empty during SSR/hydration and `new Date(iso).toLocaleString()` after mount (`useSyncExternalStore(subscribeNoop, () => true, () => false)` as the "hydrated" flag).

- [ ] **Step 1: Failing tests:** `server render emits a time element with no locale text` (`renderToString(<LocalDateTime iso="2026-10-05T14:03:00.000Z" />)` contains `dateTime="2026-10-05T14:03:00.000Z"` and not `new Date(iso).toLocaleString()`); `client render shows the browser-local string` (RTL `render` → `getByText(new Date(iso).toLocaleString())`).
- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement**; NoteCard uses `<LocalDateTime iso={new Date(note.createdAt).toISOString()} />` inside the existing `<p>`.
- [ ] **Step 4: Run** the new test → PASS.
- [ ] **Step 5: Dev-server verification.** Open `/patients/RD-0001/medical-record` as pi in a browser (or `claude-in-chrome`) with the console open; paste that no "Hydration failed"/"did not match" error appears and note dates render.
- [ ] **Step 6: Commit** — `fix(chart): render note timestamps client-side to stop the hydration mismatch`.

---

### Task 13: `/api/workbook/export` crash — reproduce, prove cause, bound it

Use superpowers:systematic-debugging. Do not change the route until Step 3's evidence names the cause.

**Files:**
- Modify (expected, confirm against evidence): `src/app/api/workbook/export/route.ts`; Create `src/lib/concurrency.ts`; Modify `src/lib/queries/form-submissions.ts` (add a bulk latest-status query)
- Test: `tests/lib/concurrency.test.ts` (new), `tests/api/workbook-export-bounded.test.ts` (new, mocked queries)

**Interfaces (if the evidence supports this fix):**
- `mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>` — preserves order, ≤ `limit` in flight, rejects on first error.
- `listLatestSubmissionStatusByPatient(): Promise<Map<string, string>>` — one `DISTINCT ON (patient_id) … ORDER BY patient_id, sent_date DESC` query.

- [ ] **Step 1: Measure the fan-out.** `npx dotenv -e .env.local -- npx tsx -e` script printing `listPatientsWithStatus(null).length`, unique patient ids, and wall time + `process.memoryUsage().rss` peak for one in-process `GET` of the route with a mocked admin session. Paste numbers.
- [ ] **Step 2: Reproduce bounded.** Dev server per protocol with `/tmp/rbac-dev.log`; fire 1, then 3, then 5 concurrent admin GETs (`for i in $(seq N); do curl -s -o /dev/null -w '%{http_code} %{time_total}\n' -H "Cookie: …" http://localhost:3300/api/workbook/export & done; wait`) while sampling `ps -o rss= -p <next-server pid>` every second. Stop at the first failure. Paste status codes, RSS series, and the last 50 lines of `/tmp/rbac-dev.log`.
- [ ] **Step 3: Name the cause** in the task report from Step 2's evidence (e.g. heap OOM, pg pool wait timeouts, Upstash 5s aborts, Turbopack worker crash). If it is NOT the export, stop and report back with the evidence instead of guessing a fix.
- [ ] **Step 4: Failing tests** (for the export-cause case): `mapWithConcurrency never exceeds the limit and preserves order`; `rejects with the first error`; `workbook export loads each unique patient detail once with at most 4 in flight` (mock `listPatientsWithStatus` with 12 rows over 10 ids, `getPatientDetail` tracking concurrency); `workbook export issues one submission-status query, not one per row`.
- [ ] **Step 5: Implement**: dedupe ids, `mapWithConcurrency(ids, 4, getPatientDetail)`, one bulk status query; row assembly unchanged so `buildWorkbookXlsx` output is identical.
- [ ] **Step 6: Run** the two new test files and the `/api/workbook/export` describes in `rbac-route-gates.test.ts` → PASS.
- [ ] **Step 7: Re-run Step 2** with 5 concurrent GETs → all 200, RSS bounded; paste.
- [ ] **Step 8: Commit** — `fix(workbook): bound the export's per-patient fan-out` (message names the proven cause).

---

### Task 14: Green harnesses, live matrix alignment, docs

**Files:**
- Modify: `tests/pages/nav-role-enforcement.test.tsx`, `tests/api/rbac-route-gates.test.ts` (add the no-gaps guards), `README.md` (Roles and sign-in: all 7 roles; new "Role access matrix" subsection under Security model generated from POLICY.md's rulings; note `src/lib/role-policy.ts` and both harnesses; drop stale "dual-sourced" Patient Detail copy at README:78-79)
- Modify (outside the repo, not committed): `/private/tmp/claude-501/-Users-k2a/22ab088d-c88d-4494-827d-f0d45bf129fc/scratchpad/matrix/probe.js`

- [ ] **Step 1: Failing guard tests:** `no PAGE_GATES row or nav entry still carries a gap tag` and `no API_GATES row still carries a gap tag` (`expect(rows.filter((r) => r.gap).map((r) => r.route ?? r.name)).toEqual([])`; `NAV_GAPS` must be `{}`). Run → PASS if Tasks 2–10 removed every tag; otherwise fix the owning task, do not delete the guard.
- [ ] **Step 2: Green evidence.** `npx dotenv -e .env.local -- npx vitest run tests/pages/nav-role-enforcement.test.tsx` and `… tests/api/rbac-route-gates.test.ts` (also with `RBAC_SHOW_GAPS=1` — must be identical since no gaps remain). Paste the summary lines next to Task 1's red list.
- [ ] **Step 3: Align `probe.js`** expectations with POLICY.md (then `routes.json` regenerates on the next run):
  - medical-record: `allow: ['crc','pi','admin']`, `special: { labs: 'redir:/labs' }` (drop the pharmacy/frontdesk stub specials).
  - `/staff`, `/staff/${id}`: add `pi`.
  - FHIR `Patient`: drop `frontdesk`; insurance-card: add `pi`; add a `back` row.
  - `/api/patients`, `/api/patients/${P}`: `['crc','pi','admin']` (ruling 1).
  - `/api/documents/${id}/download`: keep `['admin','crc','pi','frontdesk']` for the seeded non-lab document (labs denied); note the lab-order exception in `src`.
  - writes: criteria PUT `['pi','admin']` and expect 404 for allowed (`allowedMay404`), identity PUT `['admin','crc','frontdesk']`, form-submissions POST/PUT `['admin','crc','pi']`, add `POST /api/discrepancies/${N}/resolve` `['admin','crc','pi']`, webhook stays `[]`.
- [ ] **Step 4: Hand the live run to the controller** (do not run it unattended against shared data). Instructions to include in the report:

```bash
cd /Users/k2a/Desktop/clinsync/.worktrees/rbac-hardening && npx dotenv -e .env.local -- npx next dev -p 3300 > /tmp/rbac-dev.log 2>&1 &
cd /private/tmp/claude-501/-Users-k2a/22ab088d-c88d-4494-827d-f0d45bf129fc/scratchpad/matrix
rm -f results.jsonl crawl.json        # stale results from the pre-fix run
node login.js admin crc pi frontdesk pharmacy billing labs   # jars/ (reuse if present)
node probe.js && node crawl.js && node report.js              # expect "violations 0"; crawl "bad 0"
```
Done = `report.js` prints `violations 0`, `matrix.md` "Problem links: none", and the controller's per-role browser walkthrough finds no access hole or dead nav/dashboard link.
- [ ] **Step 5: Commit** — `docs(rbac): document the role access matrix; guard against reintroduced gaps`.

---

### Task 15: Patient portal login accepts the email the form asks for

**Why:** `src/app/patient-portal/login/page.tsx` labels the field "Email Address" (placeholder name@example.com) but posts it as `patientId`; `src/app/api/patient-portal/login/route.ts` only looks up a patient ID, so typing the email always fails with "Invalid patient ID or password" (verified live 2026-10-05).
**Files:** modify `src/app/api/patient-portal/login/route.ts` and the credential lookup it uses (`verifyPatientPortalCredentials` and `getPatientMfaState` — read them); tests `tests/api/patient-portal.test.ts` (and the MFA login test if it keys on patientId); the login page label may stay.
- [ ] Failing tests: (a) login with the seeded patient's EMAIL + valid portal password succeeds exactly like patient ID (create a throwaway patient fixture via the existing raw/Drizzle pattern with a known portal password hash and a unique email; delete by id); (b) an email shared by TWO patients is rejected with the same generic 401 (never pick one); (c) email matching is case-insensitive and trimmed; (d) the generic error text is identical for unknown id, unknown email and wrong password; (e) the rate limit key is the normalized identifier; (f) the MFA-required flow works when logging in by email (pending cookie carries the resolved patientId, never the email); (g) a session issued after email login carries `patientId`, not the email.
- [ ] Implement: when the identifier contains `@`, resolve it to a unique patient id by case-insensitive email match (reject on 0 or >1 matches with the generic error, after a dummy password verify to keep timing similar); otherwise treat it as the patient id as today. Keep `.strict()` schema and the field name `patientId` OR accept an additive optional `email` key — choose the smallest change and update the page accordingly; keep the page label "Email address or patient ID".
- [ ] Commit `fix(portal): patient login accepts the email the form asks for`.

### Task 16: Labs page "LIS Integration" status must be truthful

**Why:** `src/app/(dashboard)/labs/page.tsx` ~lines 46–56 shows a permanent pulsing green "Connected (HL7 / FHIR)" regardless of configuration (verified live).
**Files:** modify that page; tests `tests/pages/labs*.test.tsx` (find or create).
- [ ] Failing tests: with `LIS_INTEGRATION_TOKEN` unset the page shows "Not configured" (muted/neutral dot, no ping animation, plain text); with it set it shows "Webhook ready" (no claim of an active connection; optionally "last result received <date>" ONLY if derivable from existing lab result rows — do not add schema). Never render the token.
- [ ] Implement as a server-side boolean (`Boolean(process.env.LIS_INTEGRATION_TOKEN)`) passed to the markup; keep the layout otherwise unchanged. Commit `fix(labs): show the real LIS webhook status instead of a hardcoded Connected badge`.

### Task 17: Dashboard counts must match the lists beside them

**Why (observed live 2026-10-05):** front-desk home shows "Booking Requests 1" next to a list of 3 pending requests and the Booking Requests page lists 3 pending; "Credentials Expiring 1" next to 3 listed credentials (1 expired + 2 expiring soon); "Pending Assignments 0" while /front-desk/assignments lists 1 pending (likely "today only" vs all — check); coordinator home "Total Patients 30" vs admin home "Total Patients 66" on the same database.
**Files:** `src/components/FrontDeskDashboard.tsx` (+ its page/queries), admin/crc dashboard components and their queries (grep for the labels).
- [ ] Investigate each mismatch FIRST: read the query behind each number and decide, per metric, whether it is (a) a bug (wrong filter/definition), (b) a deliberate different definition that is merely mislabeled, or (c) pollution from test fixtures. Record the finding per metric in the report.
- [ ] Failing tests per metric that pins the intended definition against fixtures (create+delete own rows by id) — the stat and the list it sits beside must agree, or the label must say precisely what is counted (e.g. "New requests", "Expired credentials", "Checked in today").
- [ ] Fix with the smallest change (usually a corrected filter or a clearer label). Total Patients must use ONE shared query/definition across dashboards. Commit `fix(dashboards): counts agree with the lists they summarize`.

---

### Task 18: Provider identity — strict matching and video-visit ownership

**Why (Task 7 review, Important, pre-existing):** `POST /api/appointments/[id]/telemedicine` (src/app/api/appointments/[id]/telemedicine/route.ts ~10-28) only checks admin/pi, never that the pi owns the appointment; its 409 "session already exists" path returns the existing session's `patientJoinToken` with no audit row — any pi can POST a sequential appointment id for another doctor's live visit and obtain the patient join link (then join through the public token route as the patient). Separately the fuzzy `includes(lastName)` provider match is still used in ~8 places (telemedicine `end` and `signal` routes, the telemedicine page, inpatient discharge and transfer routes, patients lab-orders route, `src/lib/doctor-queue-provider.ts`, `doctor/page.tsx` ~25): "Dr. Ann Lee" matches "Dr. Bill Leeson"; three `it.fails` tests in tests/api/telemedicine-provider-ownership.test.ts pin that bug.
**Files:** create `src/lib/provider-match.ts` (+ tests `tests/lib/provider-match.test.ts`); modify the 8 sites above and the telemedicine appointment route; update `tests/api/telemedicine-provider-ownership.test.ts` (flip the three `it.fails` to normal passing tests) and add route tests.
- [ ] Failing tests first. `matchProviderByName(sessionName, providers)`: strips titles (Dr., Dr, Mr, Ms, Mrs, Prof), punctuation and initials-only tokens; matches ONLY when the LAST name token is EQUAL (case-insensitive, accent-insensitive) — never substring; returns null when zero or more than one provider matches (ambiguity is a denial, not a pick-first); empty/whitespace name -> null; "Dr. R. Kunam" matches "Dr. Rajiv Kunam"; "Dr. Ann Lee" does NOT match "Dr. Bill Leeson"; two providers both named Lee -> null.
- [ ] Resolution order everywhere: `resolveSessionProvider(session)` (the userId -> staff -> provider FK link) FIRST, then `matchProviderByName` as the fallback. Make `resolveDoctorQueueProvider` use it so the doctor page, nav badge, schedule/decline routes and telemedicine all agree. Replace the 8 fuzzy sites with that one resolver.
- [ ] Telemedicine appointment route: after the role gate, resolve the acting provider; for role `pi` require appointment.providerId === resolved provider id (403 `{error:'Forbidden'}` otherwise, BEFORE any DB write or token disclosure); admin may act on any appointment. On the 409 existing-session path return the token ONLY to an authorized caller and write an audit row (`logAudit`, action like 'requested existing telemedicine session link') — a non-owner never sees a token. Add tests: pi non-owner 403 on create AND on the 409 path with no token in the body; owner pi 201/409 with token; admin allowed; audit row on the 409 path (unique probe userName).
- [ ] Flip the three `it.fails` ownership tests to passing; run the telemedicine, doctor-queue-provider, lab-orders, discharge/transfer and schedule/decline tests; no regressions for a correctly-matched pi. Commit `fix(rbac): strict provider matching and video-visit ownership`.

---

### Task 19: Runtime robustness — Postgres pool error listener and Redis cache fail-open

**Why (Task 13 investigation, evidence in its report):** the original "dev server died" was the macOS kernel killing a memory-bloated `next dev` (NOT the workbook export). But the same investigation found two genuine production-crash risks: (1) the `pg` Pool in `src/db/client.ts` (size 10, no wait timeout) has NO `'error'` listener — an idle client whose connection Neon resets emits an unhandled `'error'` event, which in Node terminates the process; connection resets were observed live; (2) the Redis (Upstash) cache client times out after 5 s and the timeout surfaces as an unhandled rejection / 500 instead of falling back to the database (`get patients:list:all` timed out at 5003 ms).
**Files:** modify `src/db/client.ts`, the cache helper module (find it: `src/lib/cache.ts` and wherever Redis is used — grep `@upstash/redis`/`redis`), tests `tests/db/client-pool-error.test.ts` (new, mocked pg), `tests/lib/cache-failopen.test.ts` (new, mocked redis).
- [ ] Failing tests first. Pool: constructing the pool registers an `'error'` listener; emitting `'error'` on the pool does NOT throw and logs ONE concise `console.error` (message only, no connection string / credentials / query text); add `connectionTimeoutMillis` (e.g. 10_000) and `idleTimeoutMillis` (e.g. 30_000) so a stalled pool fails fast instead of hanging forever (check the current options first; do not change `max` or SSL settings). Cache: every cache read/write helper catches Redis errors and timeouts, logs a short warning (message only), and FALLS OPEN — a read returns a cache miss so the caller loads from the database; a write/invalidate failure never throws to the caller (invalidation failure must be logged loudly since stale data is possible — keep the TTL short semantics as they are). Tests: a rejecting/timing-out redis mock yields a cache miss and the underlying loader is called exactly once and its value returned; a throwing invalidate does not throw; no secret material in logged text.
- [ ] Implement minimally; keep the public signatures. Commit `fix(runtime): pool error listener and timeouts; cache fails open to the database`.

---

## Self-review

1. **Spec coverage:** patients list/detail/chart/FHIR/C-CDA/identity/insurance-card/documents → T2–T4; frontdesk reduced view → T2 (ruling 2); billing links → T9; labs redirect → T2; trials + criteria (404, age) → T5; client forms + form-submissions + form-templates → T6; appointments + calendar → T7; staff + FrontDeskDashboard → T8; charges → T9; discrepancy resolve → T3; global search UI + API → T10; Documents/Staff nav → T4/T8; Refresh button + stale copy → T2; webhook (503, constant time, audit, tests, README) → T11; Google 503 → T11; NoteCard hydration → T12; workbook export investigation → T13; DoD 1 (red→green, all 7 roles, every page/route) → T1 + T14; DoD 2 (matrix) → T14; DoD 3 (manual walkthrough) → controller, T14 Step 4.
2. **Step scan:** every code step names the file, the allowlist constant and the exact response; tests carry names and assertions; no TBDs. T13's fix is conditional on evidence by design (spec: "find the real cause, do not guess").
3. **Type consistency:** `ALL_ROLES`, `CLINICAL_ROLES`, `PATIENT_DIRECTORY_ROLES`, `SCHEDULING_ROLES`, `DOCUMENT_READ_ROLES`, `INSURANCE_CARD_READ_ROLES`, `IDENTITY_VERIFY_ROLES`, `TRIAL_CRITERIA_EDIT_ROLES`, `CHARGES_ROLES`, `searchScopesFor`, `hasSearchScope`, `SearchScopes`, `gateIt`, `gap`, `deniedRedirect`, `API_GATES`, `logIntegrationEvent`, `LocalDateTime`, `mapWithConcurrency` are defined once (T1/T11/T12/T13) and used with the same names.
4. **Review Focus:** each of the five lines has an owning test (harness DB-block + exact 403 body; T2 frontdesk view; T9 table test; T2/T4 labs; T10 search + per-task caller greps).
5. **Proportion:** code blocks are limited to harness shape, the setup commands and the verification protocol; route bodies are one-line gates described in prose.
