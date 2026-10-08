// Wave J (P1-20): page gates for every patient-portal page, in the style of
// tests/pages/page-gates-harness.ts. The portal has no roles: the gate is "a patient
// session" (requirePatientSessionOrRedirect) and, for the documents rendered outside the
// portal layout, "the current policies accepted" as well. getDb throws a sentinel, so a
// page that reads anything before its gate fails the "never touches the database" case;
// with a session the page gets past the gate and stops at the sentinel.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  session: null as { patientId: string } | null,
  accepted: true,
  mockRedirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
  mockGetDb: vi.fn(() => { throw new Error('DB_BLOCKED') }),
}))

vi.mock('next/navigation', () => ({
  redirect: (u: string) => h.mockRedirect(u),
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/patient-portal',
}))
vi.mock('@/db/client', () => ({ getDb: h.mockGetDb }))
vi.mock('@/lib/cache', () => ({
  getOrSetCache: async (_k: string, _t: number, loader: () => Promise<unknown>) => loader(),
  invalidateCache: async () => undefined,
  getRedis: () => { throw new Error('REDIS_BLOCKED') },
}))
vi.mock('@/lib/patient-session', () => ({
  requirePatientSessionOrRedirect: vi.fn(async () => {
    if (!h.session) h.mockRedirect('/patient-portal/login')
    return h.session
  }),
}))
// The consent check reads policy_documents; resolve it here so the document gate's second
// step is exercised without the database.
vi.mock('@/lib/queries/policy-documents', () => ({ hasAcceptedCurrentPolicies: vi.fn(async () => h.accepted) }))

type PortalPageCase = { route: string; load: () => Promise<{ default: (props: never) => Promise<unknown> }>; props?: unknown; document?: boolean }

const idProps = { params: Promise.resolve({ id: '1' }) }
const PORTAL_PAGES: PortalPageCase[] = [
  { route: '/patient-portal', load: () => import('@/app/patient-portal/(authenticated)/page') },
  { route: '/patient-portal/appointments', load: () => import('@/app/patient-portal/(authenticated)/appointments/page') },
  { route: '/patient-portal/lab-reports', load: () => import('@/app/patient-portal/(authenticated)/lab-reports/page') },
  { route: '/patient-portal/medications', load: () => import('@/app/patient-portal/(authenticated)/medications/page') },
  // Wave J
  { route: '/patient-portal/bills', load: () => import('@/app/patient-portal/(authenticated)/bills/page') },
  { route: '/patient-portal/discharge-summaries', load: () => import('@/app/patient-portal/(authenticated)/discharge-summaries/page') },
  { route: '/patient-portal/prescriptions', load: () => import('@/app/patient-portal/(authenticated)/prescriptions/page') },
  { route: '/patient-portal/insurance', load: () => import('@/app/patient-portal/(authenticated)/insurance/page') },
  { route: '/patient-portal/documents/invoices/[id]', load: () => import('@/app/patient-portal/documents/invoices/[id]/page'), props: idProps, document: true },
  { route: '/patient-portal/documents/receipts/[id]', load: () => import('@/app/patient-portal/documents/receipts/[id]/page'), props: idProps, document: true },
  { route: '/patient-portal/documents/discharge/[admissionId]', load: () => import('@/app/patient-portal/documents/discharge/[admissionId]/page'), props: { params: Promise.resolve({ admissionId: '1' }) }, document: true },
]

async function run(c: PortalPageCase) {
  const { default: Page } = await c.load()
  return (Page as (p: unknown) => Promise<unknown>)(c.props ?? {})
}

beforeEach(() => {
  h.session = null
  h.accepted = true
  h.mockRedirect.mockClear()
  h.mockGetDb.mockClear()
})

describe.each(PORTAL_PAGES)('portal page gate: $route', (c) => {
  it('redirects to the portal login without a patient session and never touches the database', async () => {
    await expect(run(c)).rejects.toThrow('NEXT_REDIRECT:/patient-portal/login')
    expect(h.mockGetDb).not.toHaveBeenCalled()
  })

  it('admits a patient session past the gate', async () => {
    h.session = { patientId: 'RD-0001' }
    await expect(run(c)).rejects.toThrow('DB_BLOCKED')
    expect(h.mockRedirect).not.toHaveBeenCalled()
  })

  if (c.document) {
    it('sends a patient who has not accepted the current policies to consent, before any read', async () => {
      h.session = { patientId: 'RD-0001' }
      h.accepted = false
      await expect(run(c)).rejects.toThrow('NEXT_REDIRECT:/patient-portal/consent')
      expect(h.mockGetDb).not.toHaveBeenCalled()
    })
  }
})
