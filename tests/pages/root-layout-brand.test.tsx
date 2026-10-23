// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { eq } from 'drizzle-orm'

// WL T4: the root layout reads the brand from the database at request time (getBrand), so a stored
// display name and accent colour reach the title, the theme <style> and the client BrandProvider
// without a rebuild.

vi.mock('geist/font/sans', () => ({ GeistSans: { variable: 'font-geist-sans' } }))
vi.mock('geist/font/mono', () => ({ GeistMono: { variable: 'font-geist-mono' } }))

const BRAND_VARS = ['BRAND_NAME', 'BRAND_LEGAL_NAME', 'BRAND_TAGLINE', 'BRAND_PRIMARY_COLOR', 'BRAND_LOGO_URL', 'BRAND_SUPPORT_EMAIL', 'BRAND_LOGIN_QUOTE']

async function store(values: Record<string, unknown>) {
  const { getDb } = await import('@/db/client')
  const { brandSettings } = await import('@/db/schema')
  const { resetBrandSettings } = await import('@/lib/queries/brand-settings')
  await resetBrandSettings(null)
  await getDb().update(brandSettings).set(values).where(eq(brandSettings.id, 1))
}

async function loadLayout() {
  vi.resetModules()
  const mod = await import('@/app/layout')
  const { BrandLogo } = await import('@/components/BrandLogo')
  const html = renderToStaticMarkup(await mod.default({ children: <BrandLogo /> }))
  return { mod, html }
}

describe.skipIf(!process.env.DATABASE_URL)('RootLayout reads the stored brand', () => {
  beforeEach(() => {
    for (const k of BRAND_VARS) vi.stubEnv(k, '')
  })

  afterEach(async () => {
    const { resetBrandSettings } = await import('@/lib/queries/brand-settings')
    await resetBrandSettings(null)
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('takes the title and the BrandProvider name from the stored display name', async () => {
    await store({ displayName: 'Sunrise Hospital', tagline: 'Care close to home' })
    const { mod, html } = await loadLayout()
    const meta = await mod.generateMetadata()
    expect(meta.title).toBe('Sunrise Hospital')
    expect(meta.description).toBe('Care close to home')
    expect(meta).not.toHaveProperty('icons')
    expect(html).toContain('>Sunrise Hospital</span>')
    expect(html).not.toContain('brand-theme')
  })

  it('emits the light and dark accent theme when an accent is stored, and tints the browser chrome', async () => {
    await store({ displayName: 'Sunrise Hospital', accentColor: '#ffe680' })
    const { mod, html } = await loadLayout()
    const { deriveAccentPalette } = await import('@/lib/brand-color')
    const { brandThemeCss } = await import('@/lib/brand')
    const css = brandThemeCss(deriveAccentPalette('#ffe680'))!
    expect(html).toContain(`<style id="brand-theme">${css}</style>`)
    expect(html).toContain(':root{--brand:#ffe680;}')
    const viewport = await mod.generateViewport()
    expect(viewport.themeColor).toEqual([
      { media: '(prefers-color-scheme: light)', color: '#ffe680' },
      { media: '(prefers-color-scheme: dark)', color: expect.stringMatching(/^#[0-9a-f]{6}$/) },
    ])
  })
})
