// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'

// Pure/unit: renders real pages inside the real RootLayout (so client
// components get the brand through BrandProvider exactly as in production),
// with every DB/session dependency mocked. Asserts the configured brand
// appears and the old product name never does.

function mockDeps() {
  vi.doMock('geist/font/sans', () => ({ GeistSans: { variable: 'font-geist-sans' } }))
  vi.doMock('geist/font/mono', () => ({ GeistMono: { variable: 'font-geist-mono' } }))
  vi.doMock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    usePathname: () => '/',
    notFound: () => { throw new Error('notFound') },
    redirect: (to: string) => { throw new Error(`redirect:${to}`) },
  }))
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Dr. Test', userId: null })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('@/lib/queries/prescriptions', () => ({
    getPrintablePrescriptions: vi.fn(async () => [{
      id: 1, patientId: 'RD-0001', name: 'Sertraline', medicationClass: 'SSRI', dose: '50 mg', frequencyPerDay: 1, durationDays: 30,
      instructions: null, prescribedAt: new Date('2026-10-01T00:00:00Z'), enteredByName: 'Dr. Test',
      prescriber: { name: 'Dr. Test', credentials: 'MD', specialty: 'Psychiatry' },
    }]),
  }))
  vi.doMock('@/lib/queries/patients', () => ({ getPatientIdentityForPrint: vi.fn(async () => ({ id: 'RD-0001', name: 'Test Patient', dob: '1990-01-01' })) }))
  // Wave F P1-16: the Rx slip's patient block (name, UHID, DOB for the age, gender).
  vi.doMock('@/lib/queries/print-slips', () => ({ getPatientDocumentIdentity: vi.fn(async () => ({ id: 'RD-0001', name: 'Test Patient', uhid: null, dob: '1990-01-01', gender: null })) }))
  vi.doMock('@/lib/queries/settings', () => ({ getPracticeIdentity: vi.fn(async () => ({ practiceName: null, practiceSite: null })) }))
  vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => []) }))
  vi.doMock('@/lib/queries/appointments', () => ({ listAppointmentsInRange: vi.fn(async () => []) }))
  // WL T4: the root layout reads the stored brand; none is stored here (env layer only).
  vi.doMock('@/lib/queries/brand-settings', () => ({ loadBrandSnapshot: vi.fn(async () => null) }))
}

async function setup(env: Record<string, string>) {
  for (const k of ['BRAND_NAME', 'BRAND_LEGAL_NAME', 'BRAND_LOGO_URL']) vi.stubEnv(k, '')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules()
  mockDeps()
  const { default: RootLayout } = await import('@/app/layout')
  return async (page: ReactElement) => renderToStaticMarkup(await RootLayout({ children: page }))
}

afterEach(() => {
  for (const m of ['geist/font/sans', 'geist/font/mono', 'next/navigation', '@/lib/auth', '@/lib/audit', '@/lib/queries/prescriptions', '@/lib/queries/patients', '@/lib/queries/settings', '@/lib/queries/providers', '@/lib/queries/appointments', '@/lib/queries/brand-settings']) vi.doUnmock(m)
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function renderAll(env: Record<string, string>) {
  const render = await setup(env)
  const { default: LoginPage } = await import('@/app/login/page')
  const { default: PatientPortalLoginPage } = await import('@/app/patient-portal/login/page')
  const { default: PrescriptionPrintPage } = await import('@/app/prescriptions/print/page')
  const { default: PublicBookingPage } = await import('@/app/book/page')
  const { AddClientModal } = await import('@/components/AddClientModal')
  const { ArchivePatientDialog } = await import('@/components/ArchivePatientDialog')
  const { ToastProvider } = await import('@/components/ui/toast')
  return {
    login: await render(<LoginPage />),
    portalLogin: await render(<PatientPortalLoginPage />),
    print: await render(await PrescriptionPrintPage({ searchParams: Promise.resolve({ ids: '1' }) })),
    book: await render(await PublicBookingPage()),
    // Radix dialogs portal their content, which renderToStaticMarkup does
    // not emit -- so only assert these don't throw and carry no old name.
    dialogs: await render(<ToastProvider><AddClientModal onClose={() => {}} /><ArchivePatientDialog target={{ id: 'RD-0001', name: 'X', uhid: 'UH-000001' }} onClose={() => {}} onArchived={() => {}} /></ToastProvider>),
  }
}

describe('branded pages', () => {
  it('use "Acme Health" when BRAND_NAME is set', async () => {
    const pages = await renderAll({ BRAND_NAME: 'Acme Health' })
    for (const key of ['login', 'portalLogin', 'print', 'book'] as const) {
      expect(pages[key], key).toContain('Acme Health')
    }
    expect(pages.print).toContain('entered in Acme Health. It was not transmitted')
    for (const [key, html] of Object.entries(pages)) {
      expect(html, key).not.toMatch(/clinsync/i)
      expect(html, key).not.toContain('>HIMS<')
    }
  })

  it('use "HIMS" with no BRAND_* configured', async () => {
    const pages = await renderAll({})
    for (const key of ['login', 'portalLogin', 'print', 'book'] as const) {
      expect(pages[key], key).toContain('HIMS')
    }
    for (const [key, html] of Object.entries(pages)) expect(html, key).not.toMatch(/clinsync/i)
  })

  it('prints the legal name as the slip header when no practice name is set', async () => {
    const pages = await renderAll({ BRAND_NAME: 'Acme Health', BRAND_LEGAL_NAME: 'Acme Health Pvt Ltd' })
    expect(pages.print).toContain('<p class="text-xl font-bold leading-tight">Acme Health Pvt Ltd</p>')
  })

  it('escapes HTML in BRAND_NAME on every page', async () => {
    const pages = await renderAll({ BRAND_NAME: '<img src=x onerror=alert(1)>' })
    for (const [key, html] of Object.entries(pages)) expect(html, key).not.toContain('<img src=x')
    expect(pages.login).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})
