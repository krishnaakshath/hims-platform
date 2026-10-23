import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadBrand, cookieName, brandThemeCss, appendEmailSignature, BRAND_LIMITS, DEFAULT_BRAND_NAME, DEFAULT_LOGIN_QUOTE, DEFAULT_COOKIE_PREFIX, DEFAULT_TAGLINE } from '@/lib/brand'
import { deriveAccentPalette } from '@/lib/brand-color'
import { toPublicBrand } from '@/lib/brand-resolve'

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
      loginQuote: DEFAULT_LOGIN_QUOTE,
      supportPhone: null,
      logoDarkUrl: null,
      portalName: 'Patient portal',
      login: { showDepartmentList: true },
      print: { headerText: 'HIMS', subline: null, footerText: null, signatureLine: null, address: null, gstin: null, rohiniId: null, hfrId: null, logoUrl: null },
      emailSignature: null,
      smsName: 'HIMS',
      accent: null,
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
      loginQuote: DEFAULT_LOGIN_QUOTE,
      supportPhone: null,
      logoDarkUrl: null,
      portalName: 'Patient portal',
      login: { showDepartmentList: true },
      print: {
        headerText: 'Acme Health Private Limited', subline: null, footerText: null, signatureLine: null, address: null, gstin: null,
        rohiniId: null, hfrId: null, logoUrl: 'https://cdn.acme.example/logo.svg',
      },
      emailSignature: null,
      smsName: 'Acme Health',
      accent: deriveAccentPalette('#0a7d5a'),
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

describe('brandThemeCss / toPublicBrand', () => {
  it('is null without an accent', () => {
    expect(brandThemeCss(null)).toBeNull()
  })

  it('emits exactly the --brand rule plus light and dark primary/foreground/ring (R5)', () => {
    const a = deriveAccentPalette('#ffe680')
    const css = brandThemeCss(a)!
    expect(css).toBe(
      `:root{--brand:${a.input};}` +
      `:root:not(.dark){--primary:${a.light.primary};--primary-foreground:${a.light.foreground};--ring:${a.light.primary};}` +
      `:root.dark,:root .dark{--primary:${a.dark.primary};--primary-foreground:${a.dark.foreground};--ring:${a.dark.primary};}`,
    )
    const values = css.match(/:[^;{}]+;/g)!.map((v) => v.slice(1, -1))
    for (const v of values) expect(v).toMatch(/^#[0-9a-f]{6}$/)
    expect(css).toContain(':root:not(.dark){')
    expect(css).toContain(':root.dark,:root .dark{')
  })

  it('refuses a palette carrying anything but #rrggbb, even if passed directly', () => {
    const a = deriveAccentPalette('#0a2d5a')
    expect(brandThemeCss({ ...a, input: 'red;}*{x:y' as `#${string}` })).toBeNull()
    expect(brandThemeCss({ ...a, dark: { ...a.dark, primary: '#fff}</style>' as `#${string}` } })).toBeNull()
  })

  it('exposes only the public subset (no legal/print/cookie/MFA values)', () => {
    expect(toPublicBrand(loadBrand({ BRAND_NAME: 'Acme', BRAND_SUPPORT_EMAIL: 'a@b.example' }))).toEqual({
      name: 'Acme', tagline: DEFAULT_TAGLINE, logoUrl: null, logoDarkUrl: null, portalName: 'Patient portal',
      supportEmail: 'a@b.example', supportPhone: null, loginQuote: DEFAULT_LOGIN_QUOTE, login: { showDepartmentList: true },
    })
  })

  it('appends an email signature after a standard sig separator', () => {
    expect(appendEmailSignature('Hello', null)).toBe('Hello')
    expect(appendEmailSignature('Hello', 'Sunrise Hospital\nPune')).toBe('Hello\n\n-- \nSunrise Hospital\nPune')
  })

  it('takes a configured sign-in quote with only its own attribution', () => {
    expect(loadBrand({ BRAND_LOGIN_QUOTE: '  Care,\n close to home. ' }).loginQuote).toEqual({ text: 'Care, close to home.', attribution: null })
    expect(loadBrand({ BRAND_LOGIN_QUOTE: 'Healing together.', BRAND_LOGIN_QUOTE_ATTRIBUTION: 'Our founders' }).loginQuote).toEqual({ text: 'Healing together.', attribution: 'Our founders' })
    expect(loadBrand({ BRAND_LOGIN_QUOTE: '   ', BRAND_LOGIN_QUOTE_ATTRIBUTION: 'Nobody' }).loginQuote).toEqual(DEFAULT_LOGIN_QUOTE)
    expect(Array.from(loadBrand({ BRAND_LOGIN_QUOTE: 'x'.repeat(500) }).loginQuote.text)).toHaveLength(BRAND_LIMITS.loginQuote)
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
    expect(mod.envBrand.name).toBe('Acme Health')
    expect(mod.envBrand.primaryColor).toBeNull()
    expect('brand' in mod).toBe(false) // WL T10: the deprecated sync alias is gone
    expect(mod.cookieName('session')).toBe('acme_session')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('BRAND_PRIMARY_COLOR'))
    expect(warn.mock.calls.flat().join(' ')).not.toContain('not-a-colour')
    warn.mockRestore()
  })
})
