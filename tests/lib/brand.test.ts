import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadBrand, cookieName, brandThemeCss, publicBrand, BRAND_LIMITS, DEFAULT_BRAND_NAME, DEFAULT_COOKIE_PREFIX, DEFAULT_TAGLINE } from '@/lib/brand'

describe('loadBrand defaults', () => {
  it('uses the neutral HIMS defaults when no BRAND_* var is set', () => {
    const b = loadBrand({})
    expect(DEFAULT_BRAND_NAME).toBe('HIMS')
    expect(DEFAULT_COOKIE_PREFIX).toBe('hims')
    expect(b).toEqual({
      name: 'HIMS',
      legalName: 'HIMS',
      tagline: DEFAULT_TAGLINE,
      supportEmail: null,
      logoUrl: null,
      primaryColor: null,
      cookiePrefix: 'hims',
      mfaIssuer: 'HIMS',
      systemSenderName: 'HIMS (Automated)',
    })
  })

  it('treats empty / whitespace-only values as unset', () => {
    const b = loadBrand({ BRAND_NAME: '   ', BRAND_TAGLINE: '', BRAND_PRIMARY_COLOR: ' ' })
    expect(b.name).toBe('HIMS')
    expect(b.tagline).toBe(DEFAULT_TAGLINE)
    expect(b.primaryColor).toBeNull()
  })

  it('never throws, even for a hostile env object', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom') } }) as Record<string, string>
    expect(() => loadBrand(hostile)).not.toThrow()
    expect(loadBrand(hostile).name).toBe('HIMS')
    expect(() => loadBrand(undefined as unknown as Record<string, string>)).not.toThrow()
  })
})

describe('loadBrand overrides', () => {
  it('reads every BRAND_* var', () => {
    const b = loadBrand({
      BRAND_NAME: 'Acme Health',
      BRAND_LEGAL_NAME: 'Acme Health Private Limited',
      BRAND_TAGLINE: 'Care, connected',
      BRAND_SUPPORT_EMAIL: 'help@acme.example',
      BRAND_LOGO_URL: 'https://cdn.acme.example/logo.svg',
      BRAND_PRIMARY_COLOR: '#0A7D5A',
      BRAND_COOKIE_PREFIX: 'acme',
    })
    expect(b).toEqual({
      name: 'Acme Health',
      legalName: 'Acme Health Private Limited',
      tagline: 'Care, connected',
      supportEmail: 'help@acme.example',
      logoUrl: 'https://cdn.acme.example/logo.svg',
      primaryColor: '#0a7d5a',
      cookiePrefix: 'acme',
      mfaIssuer: 'Acme Health',
      systemSenderName: 'Acme Health (Automated)',
    })
  })

  it('defaults legalName to the configured name', () => {
    expect(loadBrand({ BRAND_NAME: 'Acme Health' }).legalName).toBe('Acme Health')
  })

  it('accepts a same-origin relative logo path and a 3-digit hex colour', () => {
    const b = loadBrand({ BRAND_LOGO_URL: '/branding/acme-logo.png', BRAND_PRIMARY_COLOR: '#abc' })
    expect(b.logoUrl).toBe('/branding/acme-logo.png')
    expect(b.primaryColor).toBe('#abc')
  })
})

describe('loadBrand validation', () => {
  it.each([
    'red', '#12345', '#1234567', 'rgb(0,0,0)', '#zzzzzz',
    '#000;}body{display:none', '#fff</style><script>alert(1)</script>',
  ])('rejects primary colour %j', (value) => {
    expect(loadBrand({ BRAND_PRIMARY_COLOR: value }).primaryColor).toBeNull()
  })

  it.each([
    'http://cdn.acme.example/logo.png', 'javascript:alert(1)', 'data:image/svg+xml,<svg/>',
    '//evil.example/logo.png', '/logo".png', '/logo png', 'https://user:pw@cdn.acme.example/x.png',
    'logo.png', 'https://' + 'a'.repeat(BRAND_LIMITS.logoUrl) + '.example/x.png',
  ])('rejects logo URL %j', (value) => {
    expect(loadBrand({ BRAND_LOGO_URL: value }).logoUrl).toBeNull()
  })

  it.each(['Acme', 'acme-health', 'acme health', '', 'a'.repeat(25), 'ac.me', 'acme;'])('rejects cookie prefix %j', (value) => {
    expect(loadBrand({ BRAND_COOKIE_PREFIX: value }).cookiePrefix).toBe('hims')
  })

  it('accepts a cookie prefix of exactly 24 [a-z0-9_] characters', () => {
    const prefix = 'a_0'.repeat(8)
    expect(prefix).toHaveLength(24)
    expect(loadBrand({ BRAND_COOKIE_PREFIX: prefix }).cookiePrefix).toBe(prefix)
  })

  it.each(['not-an-email', 'a@b', 'a b@c.example', '"x"@c.example', 'x@c.example\r\nBcc: y@z.example'])('rejects support email %j', (value) => {
    expect(loadBrand({ BRAND_SUPPORT_EMAIL: value }).supportEmail).toBeNull()
  })

  it('caps text lengths', () => {
    const b = loadBrand({ BRAND_NAME: 'N'.repeat(500), BRAND_LEGAL_NAME: 'L'.repeat(500), BRAND_TAGLINE: 'T'.repeat(500) })
    expect(b.name).toHaveLength(BRAND_LIMITS.name)
    expect(b.legalName).toHaveLength(BRAND_LIMITS.legalName)
    expect(b.tagline).toHaveLength(BRAND_LIMITS.tagline)
    expect(b.mfaIssuer.length).toBeLessThanOrEqual(BRAND_LIMITS.mfaIssuer)
  })

  it('strips control characters (no header/line injection) and collapses whitespace', () => {
    const b = loadBrand({ BRAND_NAME: 'Acme\r\nBcc: x@y.example\u0000  Health' })
    expect(b.name).toBe('Acme Bcc: x@y.example Health')
    expect(b.name).not.toMatch(/[\r\n\u0000]/)
  })

  it('keeps quotes / angle brackets as literal text (React escapes them on render)', () => {
    expect(loadBrand({ BRAND_NAME: '<b>"Acme"</b>' }).name).toBe('<b>"Acme"</b>')
  })

  it('removes colons from the MFA issuer only', () => {
    const b = loadBrand({ BRAND_NAME: 'Acme: Health' })
    expect(b.name).toBe('Acme: Health')
    expect(b.mfaIssuer).toBe('Acme Health')
  })

  it('reports the NAME of each set-but-invalid var, never its value', () => {
    const onInvalid = vi.fn()
    loadBrand({ BRAND_PRIMARY_COLOR: 'red', BRAND_LOGO_URL: 'javascript:x', BRAND_COOKIE_PREFIX: 'A', BRAND_SUPPORT_EMAIL: 'x', BRAND_NAME: 'ok' }, onInvalid)
    expect(onInvalid.mock.calls.map((c) => c[0]).sort()).toEqual(['BRAND_COOKIE_PREFIX', 'BRAND_LOGO_URL', 'BRAND_PRIMARY_COLOR', 'BRAND_SUPPORT_EMAIL'])
  })
})

describe('cookieName', () => {
  it('derives every cookie from the prefix', () => {
    const b = loadBrand({})
    expect(cookieName('session', b)).toBe('hims_session')
    expect(cookieName('patient_session', b)).toBe('hims_patient_session')
    expect(cookieName('pending_staff_mfa', b)).toBe('hims_pending_staff_mfa')
    expect(cookieName('pending_patient_mfa', b)).toBe('hims_pending_patient_mfa')
    expect(cookieName('pending_google_oauth', b)).toBe('hims_pending_google_oauth')
    expect(cookieName('session', loadBrand({ BRAND_COOKIE_PREFIX: 'acme' }))).toBe('acme_session')
  })
})

describe('brandThemeCss / publicBrand', () => {
  it('is null without a colour', () => {
    expect(brandThemeCss({ primaryColor: null })).toBeNull()
  })

  it('overrides --primary for the light theme and picks a contrasting foreground', () => {
    const dark = brandThemeCss({ primaryColor: '#0a2d5a' })!
    expect(dark).toContain('--primary:#0a2d5a')
    expect(dark).toContain('--primary-foreground:oklch(0.99 0 0)')
    const light = brandThemeCss({ primaryColor: '#ffe680' })!
    expect(light).toContain('--primary-foreground:oklch(0.18 0.01 60)')
  })

  it('refuses an unvalidated colour even if passed directly', () => {
    expect(brandThemeCss({ primaryColor: 'red;}*{x:y' })).toBeNull()
  })

  it('exposes only name and logoUrl publicly', () => {
    expect(publicBrand(loadBrand({ BRAND_NAME: 'Acme', BRAND_SUPPORT_EMAIL: 'a@b.example' }))).toEqual({ name: 'Acme', logoUrl: null })
  })
})

describe('module-level brand from process.env', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('reads BRAND_* at import and falls back (with a warning, not a throw) on bad values', async () => {
    vi.stubEnv('BRAND_NAME', 'Acme Health')
    vi.stubEnv('BRAND_PRIMARY_COLOR', 'not-a-colour')
    vi.stubEnv('BRAND_COOKIE_PREFIX', 'acme')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.resetModules()
    const mod = await import('@/lib/brand')
    expect(mod.brand.name).toBe('Acme Health')
    expect(mod.brand.primaryColor).toBeNull()
    expect(mod.cookieName('session')).toBe('acme_session')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('BRAND_PRIMARY_COLOR'))
    expect(warn.mock.calls.flat().join(' ')).not.toContain('not-a-colour')
    warn.mockRestore()
  })
})
