import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { Session } from '@/lib/auth'
import type { BrandSettingsInput } from '@/lib/brand-snapshot'

// WL T9 (lane ruling R6): the sign-in pages follow the brand stored in Settings > Branding -- the
// stored logo and name on the badge, the stored quote and attribution, the department list toggle
// and the patient portal name -- resolved exactly as the root layout does (getPublicBrand).

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

const BRAND_VARS = [
  'BRAND_NAME', 'BRAND_LEGAL_NAME', 'BRAND_TAGLINE', 'BRAND_PRIMARY_COLOR', 'BRAND_LOGO_URL', 'BRAND_SUPPORT_EMAIL',
  'BRAND_LOGIN_QUOTE', 'BRAND_LOGIN_QUOTE_ATTRIBUTION', 'BRAND_COOKIE_PREFIX',
]

describe.skipIf(!process.env.DATABASE_URL)('sign-in pages read the stored brand (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const ACTOR = `TEST-WL-T9-${RUN}`
  const session: Session = { role: 'admin', name: ACTOR, userId: null }

  const blank = (over: Partial<BrandSettingsInput> = {}): BrandSettingsInput => ({
    displayName: null, tagline: null, supportEmail: null, supportPhone: null, accentColor: null, logoUrl: null,
    loginQuote: null, loginQuoteAttribution: null, loginShowDepartmentList: true, portalName: null, printHeaderText: null,
    printFooterText: null, printSignatureLine: null, emailSignature: null, smsName: null, ...over,
  })

  beforeEach(() => {
    for (const k of BRAND_VARS) vi.stubEnv(k, '')
    vi.resetModules()
  })

  afterEach(async () => {
    cleanup()
    const { resetBrandSettings } = await import('@/lib/queries/brand-settings')
    await resetBrandSettings(null)
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  afterAll(async () => {
    const { getDb } = await import('@/db/client')
    const { auditLog } = await import('@/db/schema')
    const { eq } = await import('drizzle-orm')
    await getDb().delete(auditLog).where(eq(auditLog.userName, ACTOR))
  })

  async function storeSunrise() {
    const q = await import('@/lib/queries/brand-settings')
    await q.resetBrandSettings(null)
    const r = await q.updateBrandSettings(blank({
      displayName: 'Sunrise Hospital', loginQuote: 'Care, close to home', loginQuoteAttribution: 'Sunrise Hospital',
      loginShowDepartmentList: false, portalName: 'Sunrise MyCare',
    }), 0, session)
    expect(r.ok).toBe(true)
    await q.putBrandAsset('logo_light', {
      source: 'upload', blobUrl: `local:branding/test-${RUN}.png`, sha256: 'a1'.repeat(32), width: 400, height: 100, byteSize: 1234,
    }, session)
    const { getPublicBrand } = await import('@/lib/brand-server')
    return getPublicBrand()
  }

  async function renderWithBrand(load: () => Promise<{ default: () => React.ReactNode }>) {
    const pb = await storeSunrise()
    const { BrandProvider } = await import('@/components/BrandProvider')
    const Page = (await load()).default
    render(<BrandProvider brand={pb}><Page /></BrandProvider>)
  }

  it('staff /login: stored logo, quote and attribution; no department list', async () => {
    await renderWithBrand(() => import('@/app/login/page'))
    const logo = screen.getByRole('img', { name: 'Sunrise Hospital' })
    expect(logo.getAttribute('src')).toMatch(/^\/branding\/logo-light-[0-9a-f]{16}\.png$/)
    const figure = screen.getByText('Care, close to home').closest('figure')!
    expect(figure).toHaveTextContent('Sunrise Hospital')
    expect(screen.queryByRole('button', { name: /department sign-in/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Department sign-in')).not.toBeInTheDocument()
  })

  it('a department URL (/login/admin) still renders its sign-in, without the department list', async () => {
    await renderWithBrand(() => import('@/app/login/admin/page'))
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByLabelText('Email address')).toBeInTheDocument()
    expect(screen.queryByText('Department sign-in')).not.toBeInTheDocument()
  })

  it('patient sign-in names the stored portal', async () => {
    await renderWithBrand(() => import('@/app/patient-portal/login/page'))
    expect(screen.getByText('Sunrise MyCare')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Sunrise Hospital' })).toBeInTheDocument()
  })
})
