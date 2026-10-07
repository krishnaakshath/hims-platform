import { it, vi } from 'vitest'
import type { Role } from '@/lib/auth'
import { ALL_ROLES as POLICY_ALL_ROLES } from '@/lib/role-policy'

// Plain (non-`.test.`) helper module so Tasks 2-5 can import `PageGateCase`,
// `runPage`, `PAGE_GATES`, and `ALL_ROLES` without re-triggering
// `nav-role-enforcement.test.tsx`'s own `describe`/`it` registration --
// importing a `.test.tsx` file from another test file makes vitest load and
// re-run every test in it a second time.
//
// This harness follows tests/pages/audit-log.test.tsx's vi.hoisted +
// vi.resetModules() + per-case vi.doMock shape, with three deliberate
// changes, each documented at its mock below:
//
// 1. mockRedirect THROWS (like the real next/navigation redirect()) instead
//    of just recording a call. That is what stops a denied role's page body
//    from running on into the data fetch after the gate -- without the
//    throw, a page that calls redirect() but doesn't return/throw afterward
//    would still execute its DB queries, and Review Focus #1 wouldn't be
//    able to tell the difference.
// 2. @/db/client's getDb is mocked to throw DB_BLOCKED, so no page in the
//    table needs its own query modules mocked. An allowed role gets past the
//    gate and dies at the DB sentinel; the assertion is about mockRedirect,
//    not about rendering.
// 3. @/lib/cache's getOrSetCache is forced to always call its loader (never
//    short-circuit to a cached value), and getRedis is blocked outright.
//    getOrSetCache reads from live shared Upstash Redis before ever calling
//    its loader -- and therefore before ever calling getDb. Task 1's two
//    page loaders (workbook, identity-matching) throw before anything gets
//    cached, so this was safe by accident; Tasks 2-5 add pages whose loaders
//    succeed (patients, trials, charges, forms lists) and populate Redis,
//    after which a page with a MISSING gate could still pass "never touches
//    the database for a denied role" as a false negative by serving a
//    previously-cached value instead of calling getDb. Forcing every call
//    through the loader (and blocking the real client) closes that gap.
// vi.hoisted can't itself be the target of a destructuring `export const`
// (its hoisting transform requires the declaration to be a plain identifier
// or destructure with no `export` keyword directly on it) -- so hoist into
// a private binding and re-export the two fields separately.
const hoistedMocks = vi.hoisted(() => ({
  mockRedirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }),
  mockGetDb: vi.fn(() => { throw new Error('DB_BLOCKED') }),
}))
export const mockRedirect = hoistedMocks.mockRedirect
export const mockGetDb = hoistedMocks.mockGetDb

export type PageGateCase = {
  route: string // the URL path, e.g. '/forms/[templateId]'
  load: () => Promise<{ default: (props: never) => Promise<unknown> }>
  props?: unknown // { params: Promise<...>, searchParams: Promise<...> }
  allowed: Role[] // POLICY.md / LeftNav.tsx, cited in a comment
  // Where a denied role is sent, when it is not '/' (e.g. labs -> '/labs').
  deniedRedirect?: Partial<Record<Role, string>>
  // A known, not-yet-fixed gap: the task id (e.g. 'T2') that closes it. The
  // row's tests run as `it.fails` until that task removes the tag; set
  // RBAC_SHOW_GAPS=1 to run them as normal tests and see the red list.
  gap?: string
  // Where the gap lives. Default: the DENY side (a missing gate) -- the
  // "admits every allowed role" test always runs as a plain `it`, so a wrong
  // redirect of an allowed role is visible immediately, and only the
  // "redirects every denied role" + "never touches the database" tests run
  // under the gap tag. 'allowed' flips that for a row whose gate already
  // runs before any query and is merely the wrong allowlist (e.g. /staff
  // bouncing pi): only the allowed-role test is the gap, and both deny-side
  // tests run as plain `it`.
  gapOnly?: 'allowed'
}

export const ALL_ROLES: readonly Role[] = POLICY_ALL_ROLES

// `it.fails` for a gap-tagged row (so the tree stays green while proving the
// gap is still real -- if the gap closes without the tag being removed, the
// `it.fails` itself fails), plain `it` otherwise or when RBAC_SHOW_GAPS is set.
// Callers pass the gap only to the half of a row that is actually open (see
// PageGateCase.gapOnly); the other half always runs as a plain `it`.
export function gateIt(c: { gap?: string }) {
  return c.gap && !process.env.RBAC_SHOW_GAPS ? it.fails : it
}

export async function runPage(c: PageGateCase, role: Role) {
  vi.resetModules()
  mockRedirect.mockClear()
  mockGetDb.mockClear()
  vi.doMock('next/navigation', () => ({
    redirect: mockRedirect,
    notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('@/db/client', () => ({ getDb: mockGetDb }))
  vi.doMock('@/lib/cache', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/cache')>()),
    getOrSetCache: (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader(),
    getRedis: () => { throw new Error('REDIS_BLOCKED') },
  }))
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: `Test ${role}`, userId: null })) }))
  const mod = await c.load()
  try { await mod.default(c.props as never) } catch { /* DB_BLOCKED, REDIS_BLOCKED, NEXT_REDIRECT and render errors after the gate are all fine */ }
}

export const PAGE_GATES: PageGateCase[] = [
  // LeftNav.tsx:33
  { route: '/workbook', load: () => import('@/app/(dashboard)/workbook/page'), allowed: ['admin', 'crc', 'pi'] },
  // LeftNav.tsx:37
  { route: '/forms', load: () => import('@/app/(dashboard)/forms/page'), allowed: ['admin', 'crc', 'pi'] },
  { 
    route: '/forms/[templateId]',
    load: () => import('@/app/(dashboard)/forms/[templateId]/page'),
    props: { params: Promise.resolve({ templateId: '1' }) },
    allowed: ['admin', 'crc', 'pi'],
  },
  // Forms hub sub-pages (feature/forms-redesign) -- same gate as /forms.
  {
    route: '/forms/folders/[folderId]',
    load: () => import('@/app/(dashboard)/forms/folders/[folderId]/page'),
    props: { params: Promise.resolve({ folderId: '1' }) },
    allowed: ['admin', 'crc', 'pi'],
  },
  { route: '/forms/archived', load: () => import('@/app/(dashboard)/forms/archived/page'), allowed: ['admin', 'crc', 'pi'] },
  // LeftNav.tsx:52
  { route: '/consent-documents', load: () => import('@/app/(dashboard)/consent-documents/page'), allowed: ['admin', 'crc', 'pi'] },
  {
    route: '/consent-documents/[id]',
    load: () => import('@/app/(dashboard)/consent-documents/[id]/page'),
    props: { params: Promise.resolve({ id: '1' }) },
    allowed: ['admin', 'crc', 'pi'],
  },
  // billing/page.tsx:31 -- the billing home, same gate as its sub-pages
  { route: '/billing', load: () => import('@/app/(dashboard)/billing/page'), allowed: ['admin', 'crc', 'billing'] },
  // LeftNav.tsx:98 — showBilling
  { route: '/billing/charges', load: () => import('@/app/(dashboard)/billing/charges/page'), allowed: ['admin', 'crc', 'billing'] },
  // LeftNav.tsx:98 — showBilling
  {
    route: '/billing/charges/[chargeId]',
    load: () => import('@/app/(dashboard)/billing/charges/[chargeId]/page'),
    props: { params: Promise.resolve({ chargeId: '1' }) },
    allowed: ['admin', 'crc', 'billing'],
  },
  // LeftNav.tsx:98 — showBilling
  { route: '/billing/insurance-collections', load: () => import('@/app/(dashboard)/billing/insurance-collections/page'), allowed: ['admin', 'crc', 'billing'] },
  // LeftNav.tsx:98 — showBilling
  { route: '/billing/patient-collections', load: () => import('@/app/(dashboard)/billing/patient-collections/page'), allowed: ['admin', 'crc', 'billing'] },
  // LeftNav.tsx:98 — showBilling
  { route: '/billing/statements', load: () => import('@/app/(dashboard)/billing/statements/page'), allowed: ['admin', 'crc', 'billing'] },
  // LeftNav.tsx:98 — showBilling
  { route: '/billing/ar-dashboard', load: () => import('@/app/(dashboard)/billing/ar-dashboard/page'), allowed: ['admin', 'crc', 'billing'] },
  // LeftNav.tsx:98 — showBilling
  { route: '/billing/analytics', load: () => import('@/app/(dashboard)/billing/analytics/page'), allowed: ['admin', 'crc', 'billing'] },
  // LeftNav.tsx:98 — showBilling
  {
    route: '/billing/pay',
    load: () => import('@/app/(dashboard)/billing/pay/page'),
    props: { searchParams: Promise.resolve({}) },
    allowed: ['admin', 'crc', 'billing'],
  },
  // LeftNav.tsx:60 — { href: '/reports', roles: ['admin', 'crc'] }. No row
  // for (dashboard)/reports/page.tsx itself: it is a bare
  // redirect('/reports/patients') with no session read, and once this leaf
  // is gated it grants nothing (spec §3.2) -- Task 5's coverage rule
  // matches the /reports nav href via this leaf instead.
  { route: '/reports/patients', load: () => import('@/app/(dashboard)/reports/patients/page'), allowed: ['admin', 'crc'] },
  // LeftNav.tsx:60 — { href: '/reports', roles: ['admin', 'crc'] }
  { route: '/reports/appointments/all', load: () => import('@/app/(dashboard)/reports/appointments/all/page'), allowed: ['admin', 'crc'] },
  // LeftNav.tsx:60 — { href: '/reports', roles: ['admin', 'crc'] }
  { route: '/reports/claims/insurance-collections', load: () => import('@/app/(dashboard)/reports/claims/insurance-collections/page'), allowed: ['admin', 'crc'] },
  // LeftNav.tsx:60 — { href: '/reports', roles: ['admin', 'crc'] }
  { route: '/reports/encounters/all', load: () => import('@/app/(dashboard)/reports/encounters/all/page'), allowed: ['admin', 'crc'] },
  // LeftNav.tsx:60 — { href: '/reports', roles: ['admin', 'crc'] }
  { route: '/reports/notes/unsigned', load: () => import('@/app/(dashboard)/reports/notes/unsigned/page'), allowed: ['admin', 'crc'] },
  // POLICY.md: Documents -- admin, crc, pi (read), frontdesk (receive/file).
  { route: '/documents', load: () => import('@/app/(dashboard)/documents/page'), allowed: ['admin', 'crc', 'pi', 'frontdesk'] },
  // LeftNav.tsx:61 — { href: '/documents', roles: ['admin', 'crc'] }
  { route: '/documents/fax-history', load: () => import('@/app/(dashboard)/documents/fax-history/page'), allowed: ['admin', 'crc'] },
  // LeftNav.tsx:64 — { href: '/pipeline-dashboard', roles: ['admin', 'crc'] }
  {
    route: '/pipeline-dashboard',
    load: () => import('@/app/(dashboard)/pipeline-dashboard/page'),
    props: { searchParams: Promise.resolve({}) },
    allowed: ['admin', 'crc'],
  },

  // LeftNav.tsx:62 — { href: '/broadcasts', roles: ['admin', 'crc'] }
  {
    route: '/broadcasts',
    load: () => import('@/app/(dashboard)/broadcasts/page'),
    props: { searchParams: Promise.resolve({}) },
    allowed: ['admin', 'crc'],
  },
  // LeftNav.tsx:62 — { href: '/broadcasts', roles: ['admin', 'crc'] }
  {
    route: '/broadcasts/[id]',
    load: () => import('@/app/(dashboard)/broadcasts/[id]/page'),
    props: { params: Promise.resolve({ id: '1' }) },
    allowed: ['admin', 'crc'],
  },
  // LeftNav.tsx:63 — { href: '/experience-surveys', roles: ['admin', 'crc'] }
  {
    route: '/experience-surveys',
    load: () => import('@/app/(dashboard)/experience-surveys/page'),
    props: { searchParams: Promise.resolve({}) },
    allowed: ['admin', 'crc'],
  },
  // LeftNav.tsx:63 — { href: '/experience-surveys', roles: ['admin', 'crc'] }
  {
    route: '/experience-surveys/[id]',
    load: () => import('@/app/(dashboard)/experience-surveys/[id]/page'),
    props: { params: Promise.resolve({ id: '1' }) },
    allowed: ['admin', 'crc'],
  },

  // The seven nav entries below were already gated before this plan (Task
  // 5 pins them so the derivation assertions cover the whole nav, not just
  // this branch's diff).
  // LeftNav.tsx:31 — { href: '/doctor', roles: ['pi'] }
  { route: '/doctor', load: () => import('@/app/(dashboard)/doctor/page'), allowed: ['pi'] },
  // LeftNav.tsx:39 — { href: '/front-desk/check-in', roles: ['frontdesk', 'admin', 'crc'] }
  { route: '/front-desk/check-in', load: () => import('@/app/(dashboard)/front-desk/check-in/page'), allowed: ['frontdesk', 'admin', 'crc'] },
  // LeftNav.tsx:40 — { href: '/front-desk/assignments', roles: ['frontdesk', 'admin', 'crc'] }
  { route: '/front-desk/assignments', load: () => import('@/app/(dashboard)/front-desk/assignments/page'), allowed: ['frontdesk', 'admin', 'crc'] },
  // LeftNav.tsx — { href: '/front-desk/follow-ups', roles: ['frontdesk', 'admin', 'crc'] }
  {
    route: '/front-desk/follow-ups',
    load: () => import('@/app/(dashboard)/front-desk/follow-ups/page'),
    props: { searchParams: Promise.resolve({}) },
    allowed: ['frontdesk', 'admin', 'crc'],
  },
  // LeftNav.tsx:41 — { href: '/inpatient/beds', roles: ['frontdesk', 'admin', 'crc', 'pi'] }
  { route: '/inpatient/beds', load: () => import('@/app/(dashboard)/inpatient/beds/page'), allowed: ['frontdesk', 'admin', 'crc', 'pi'] },
  // LeftNav.tsx:43 — { href: '/labs', roles: ['admin', 'crc', 'pi', 'labs'] }
  { route: '/labs', load: () => import('@/app/(dashboard)/labs/page'), allowed: ['admin', 'crc', 'pi', 'labs'] },
  // LeftNav.tsx:45 — { href: '/booking-requests', roles: ['frontdesk', 'admin', 'crc', 'pi'] }
  { route: '/booking-requests', load: () => import('@/app/(dashboard)/booking-requests/page'), allowed: ['frontdesk', 'admin', 'crc', 'pi'] },
  // LeftNav.tsx:65 — { href: '/audit-log', roles: ['admin'] }
  { route: '/audit-log', load: () => import('@/app/(dashboard)/audit-log/page'), allowed: ['admin'] },
  // Missing nav items:
  // POLICY.md: patients list -- admin, crc, pi, frontdesk (PATIENT_DIRECTORY_ROLES)
  {
    route: '/patients',
    load: () => import('@/app/(dashboard)/patients/page'),
    props: { searchParams: Promise.resolve({}) },
    allowed: ['crc', 'pi', 'admin', 'frontdesk'],
  },
  // POLICY.md: patient detail -- PATIENT_DIRECTORY_ROLES (frontdesk: reduced view)
  {
    route: '/patients/[anonId]',
    load: () => import('@/app/(dashboard)/patients/[anonId]/page'),
    props: { params: Promise.resolve({ anonId: 'RD-0001' }) },
    allowed: ['admin', 'crc', 'pi', 'frontdesk'],
  },
  // POLICY.md: chart -- CLINICAL_ROLES; labs is sent to its worklist (ruling 3)
  {
    route: '/patients/[anonId]/medical-record',
    load: () => import('@/app/(dashboard)/patients/[anonId]/medical-record/page'),
    props: { params: Promise.resolve({ anonId: 'RD-0001' }) },
    allowed: ['admin', 'crc', 'pi'],
    deniedRedirect: { labs: '/labs' },
  },
  { route: '/trials', load: () => import('@/app/(dashboard)/trials/page'), allowed: ['crc', 'pi', 'admin'] },
  // POLICY.md: Trials -- crc, pi, admin
  {
    route: '/trials/[trialId]',
    load: () => import('@/app/(dashboard)/trials/[trialId]/page'),
    props: { params: Promise.resolve({ trialId: 'nct-adhd-demo-01' }) },
    allowed: ['admin', 'crc', 'pi'],
  },
  // POLICY.md: Appointments + calendar -- SCHEDULING_ROLES
  {
    route: '/calendar',
    load: () => import('@/app/(dashboard)/calendar/page'),
    props: { searchParams: Promise.resolve({}) },
    allowed: ['crc', 'pi', 'admin', 'frontdesk'],
  },
  // telemedicine/[sessionId]/page.tsx -- admin, pi. The role gate runs before
  // getSessionById, so denied roles never touch the database.
  {
    route: '/telemedicine/[sessionId]',
    load: () => import('@/app/(dashboard)/telemedicine/[sessionId]/page'),
    props: { params: Promise.resolve({ sessionId: '1' }) },
    allowed: ['admin', 'pi'],
  },
  {
    route: '/client-forms',
    load: () => import('@/app/(dashboard)/client-forms/page'),
    props: { searchParams: Promise.resolve({}) },
    allowed: ['crc', 'pi', 'admin'],
  },
  // POLICY.md: Client forms -- crc, pi, admin
  {
    route: '/client-forms/[id]',
    load: () => import('@/app/(dashboard)/client-forms/[id]/page'),
    props: { params: Promise.resolve({ id: '1' }) },
    allowed: ['admin', 'crc', 'pi'],
  },
  { route: '/pharmacy', load: () => import('@/app/(dashboard)/pharmacy/page'), allowed: ['crc', 'pi', 'admin', 'pharmacy'] },
  { route: '/pharmacy/patient-lookup', load: () => import('@/app/(dashboard)/pharmacy/patient-lookup/page'), allowed: ['pharmacy', 'admin'] },
  { route: '/pharmacy/billing', load: () => import('@/app/(dashboard)/pharmacy/billing/page'), allowed: ['pharmacy', 'admin'] },
  // POLICY.md: Staff directory -- admin, crc, pi (view)
  { route: '/staff', load: () => import('@/app/(dashboard)/staff/page'), allowed: ['admin', 'crc', 'pi'] },
  {
    route: '/staff/[id]',
    load: () => import('@/app/(dashboard)/staff/[id]/page'),
    props: { params: Promise.resolve({ id: '1' }) },
    allowed: ['admin', 'crc', 'pi'],
  },
  { route: '/messages', load: () => import('@/app/(dashboard)/messages/page'), props: { searchParams: Promise.resolve({}) }, allowed: ['crc', 'pi', 'admin', 'pharmacy'] },
  // LeftNav NAV_TRAILING_ITEMS /tariffs -- TARIFF_MANAGE_ROLES
  { route: '/tariffs', load: () => import('@/app/(dashboard)/tariffs/page'), props: { searchParams: Promise.resolve({}) }, allowed: ['admin', 'billing'] },
  { route: '/tariffs/services/[id]', load: () => import('@/app/(dashboard)/tariffs/services/[id]/page'), props: { params: Promise.resolve({ id: '1' }) }, allowed: ['admin', 'billing'] },
  { route: '/tariffs/room-categories', load: () => import('@/app/(dashboard)/tariffs/room-categories/page'), allowed: ['admin', 'billing'] },
  { route: '/tariffs/import', load: () => import('@/app/(dashboard)/tariffs/import/page'), allowed: ['admin', 'billing'] },
  { route: '/settings', load: () => import('@/app/(dashboard)/settings/page'), allowed: ['admin', 'pi'] },
  // SP6: LeftNav NAV_TRAILING_ITEMS /coding/code-systems -- CODE_SYSTEM_ADMIN_ROLES
  { route: '/coding/code-systems', load: () => import('@/app/(dashboard)/coding/code-systems/page'), allowed: ['admin'] },
  // SP6: LeftNav NAV_ITEMS /coding -- CODING_ROLES (worklist, productivity report)
  { route: '/coding', load: () => import('@/app/(dashboard)/coding/page'), props: { searchParams: Promise.resolve({}) }, allowed: ['admin', 'coder'] },
  { route: '/coding/report', load: () => import('@/app/(dashboard)/coding/report/page'), props: { searchParams: Promise.resolve({}) }, allowed: ['admin', 'coder'] },
  { route: '/coding/encounters/[id]', load: () => import('@/app/(dashboard)/coding/encounters/[id]/page'), props: { params: Promise.resolve({ id: '1' }) }, allowed: ['admin', 'coder'] },
  // end SP6
  // Outside (dashboard), so the page-file walk does not require it: the
  // prescription print slip follows the chart's gate (CLINICAL_ROLES).
  {
    route: '/prescriptions/print',
    load: () => import('@/app/prescriptions/print/page'),
    props: { searchParams: Promise.resolve({ ids: '1' }) },
    allowed: ['admin', 'crc', 'pi'],
  },
]
