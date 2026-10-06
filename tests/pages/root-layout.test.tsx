import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/font/google', () => ({
  Geist: () => ({ variable: 'font-geist-sans' }),
  Geist_Mono: () => ({ variable: 'font-geist-mono' }),
}))

async function loadLayout() {
  vi.resetModules()
  const layoutMod = await import('@/app/layout')
  const { BrandLogo } = await import('@/components/BrandLogo')
  const html = renderToStaticMarkup(<layoutMod.default><BrandLogo /></layoutMod.default>)
  return { metadata: layoutMod.metadata, html }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('RootLayout branding', () => {
  it('uses the HIMS defaults and injects no theme override when BRAND_* is unset', async () => {
    for (const k of ['BRAND_NAME', 'BRAND_TAGLINE', 'BRAND_PRIMARY_COLOR', 'BRAND_LOGO_URL']) vi.stubEnv(k, '')
    const { metadata, html } = await loadLayout()
    expect(metadata.title).toBe('HIMS')
    expect(typeof metadata.description).toBe('string')
    expect(html).toContain('>HIMS</span>')
    expect(html).not.toContain('brand-theme')
  })

  it('takes title/description from the brand and feeds the brand to client components', async () => {
    vi.stubEnv('BRAND_NAME', 'Acme Health')
    vi.stubEnv('BRAND_TAGLINE', 'Care, connected')
    const { metadata, html } = await loadLayout()
    expect(metadata.title).toBe('Acme Health')
    expect(metadata.description).toBe('Care, connected')
    expect(html).toContain('>Acme Health</span>')
  })

  it('injects --primary from a valid BRAND_PRIMARY_COLOR', async () => {
    vi.stubEnv('BRAND_PRIMARY_COLOR', '#0a7d5a')
    const { html } = await loadLayout()
    expect(html).toMatch(/<style id="brand-theme">:root:not\(\.dark\)\{--primary:#0a7d5a;/)
  })

  it('ignores an invalid colour instead of injecting it', async () => {
    vi.stubEnv('BRAND_PRIMARY_COLOR', '#fff}</style><script>alert(1)</script>')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { html } = await loadLayout()
    expect(html).not.toContain('brand-theme')
    expect(html).not.toContain('<script>')
  })

  it('escapes an HTML-looking brand name', async () => {
    vi.stubEnv('BRAND_NAME', '<script>alert(1)</script>')
    const { html } = await loadLayout()
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
