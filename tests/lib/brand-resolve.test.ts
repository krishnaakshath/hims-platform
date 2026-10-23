import { describe, it, expect } from 'vitest'
import { loadBrand } from '@/lib/brand'
import { deriveAccentPalette } from '@/lib/brand-color'
import { brandAssetPath, resolveBrand, toPublicBrand } from '@/lib/brand-resolve'
import type { BrandAssetKind, BrandSnapshot } from '@/lib/brand-snapshot'

// WL T4: per-field DB -> env -> default layering (spec §2 D1/D3/D4, §5.1; lane rulings R2/R3).

const SHA = (c: string) => c.repeat(64)

function snap(settings: Partial<BrandSnapshot['settings']> = {}, extra: Partial<Omit<BrandSnapshot, 'settings'>> = {}): BrandSnapshot {
  return {
    settings: {
      id: 1, revision: 1, displayName: null, tagline: null, supportEmail: null, supportPhone: null, accentColor: null, logoUrl: null,
      loginQuote: null, loginQuoteAttribution: null, loginShowDepartmentList: true, portalName: null, printHeaderText: null,
      printFooterText: null, printSignatureLine: null, emailSignature: null, smsName: null, onboardingTestSigninAt: null,
      onboardingDismissedAt: null, updatedAt: '2026-10-23T00:00:00.000Z', updatedByName: null, ...settings,
    },
    assets: [],
    billing: null,
    practice: null,
    ...extra,
  }
}

function asset(kind: BrandAssetKind, sha256: string): BrandSnapshot['assets'][number] {
  return {
    kind, source: 'upload', blobUrl: `local://secret-store/brand/${kind}.png`, sha256, contentType: 'image/png',
    width: 100, height: 100, byteSize: 1000, createdAt: '2026-10-23T00:00:00.000Z', createdByName: 'Admin',
  }
}

const ENV = { BRAND_NAME: 'Env Hospital', BRAND_TAGLINE: 'Env tagline', BRAND_SUPPORT_EMAIL: 'env@hospital.example' }

describe('resolveBrand', () => {
  it('with no snapshot is exactly the env brand', () => {
    const env = loadBrand(ENV)
    expect(resolveBrand(env, null)).toEqual(loadBrand(ENV))
  })

  it('env brand carries the built-in defaults for the new fields', () => {
    const b = loadBrand({})
    expect(b.supportPhone).toBeNull()
    expect(b.logoDarkUrl).toBeNull()
    expect(b.portalName).toBe('Patient portal')
    expect(b.login).toEqual({ showDepartmentList: true })
    expect(b.print).toEqual({
      headerText: 'HIMS', subline: null, footerText: null, signatureLine: null, address: null, gstin: null, rohiniId: null, hfrId: null, logoUrl: null,
    })
    expect(b.emailSignature).toBeNull()
    expect(b.smsName).toBe('HIMS')
    expect(b.accent).toBeNull()
    expect(b).not.toHaveProperty('icons')
  })

  it('a pristine snapshot changes nothing but keeps the env values', () => {
    const env = loadBrand(ENV)
    expect(resolveBrand(env, snap())).toEqual(env)
  })

  it('layers each field on its own: DB beats env beats default', () => {
    expect(resolveBrand(loadBrand({}), snap({ displayName: 'Sunrise Hospital' })).name).toBe('Sunrise Hospital')
    expect(resolveBrand(loadBrand(ENV), snap({ displayName: 'Sunrise Hospital' })).name).toBe('Sunrise Hospital')
    expect(resolveBrand(loadBrand(ENV), snap()).name).toBe('Env Hospital')
    expect(resolveBrand(loadBrand({}), snap()).name).toBe('HIMS')
    const b = resolveBrand(loadBrand(ENV), snap({ displayName: 'Sunrise Hospital', tagline: null, supportPhone: '+91 98765 43210', portalName: 'MyCare' }))
    expect(b.tagline).toBe('Env tagline')
    expect(b.supportEmail).toBe('env@hospital.example')
    expect(b.supportPhone).toBe('+91 98765 43210')
    expect(b.portalName).toBe('MyCare')
    expect(resolveBrand(loadBrand(ENV), snap({ tagline: 'Care close to home', supportEmail: 'help@sunrise.example' }))).toMatchObject({
      tagline: 'Care close to home', supportEmail: 'help@sunrise.example',
    })
  })

  it('legal name: billing, then BRAND_LEGAL_NAME, then the resolved name', () => {
    const withEnvLegal = loadBrand({ ...ENV, BRAND_LEGAL_NAME: 'Env Hospital Pvt Ltd' })
    const billing = { legalName: 'Sunrise Healthcare Pvt Ltd', address: null, gstin: null, rohiniId: null, hfrId: null }
    expect(resolveBrand(withEnvLegal, snap({ displayName: 'Sunrise' }, { billing })).legalName).toBe('Sunrise Healthcare Pvt Ltd')
    expect(resolveBrand(withEnvLegal, snap({ displayName: 'Sunrise' })).legalName).toBe('Env Hospital Pvt Ltd')
    expect(resolveBrand(loadBrand(ENV), snap({ displayName: 'Sunrise' })).legalName).toBe('Sunrise')
    expect(resolveBrand(loadBrand(ENV), snap({ displayName: 'Sunrise' }, { billing: { ...billing, legalName: '  ' } })).legalName).toBe('Sunrise')
  })

  it('print header: printHeaderText, then billing legal name, then practiceName, then env legal name', () => {
    const env = loadBrand({ ...ENV, BRAND_LEGAL_NAME: 'Env Hospital Pvt Ltd' })
    const billing = { legalName: 'Sunrise Healthcare Pvt Ltd', address: '12 MG Road, Pune', gstin: '27ABCDE1234F1Z5', rohiniId: 'R123', hfrId: 'IN2710000001' }
    const practice = { practiceName: 'Sunrise Clinic', practiceSite: 'Pune, Maharashtra' }
    expect(resolveBrand(env, snap({ printHeaderText: 'Sunrise Multispeciality' }, { billing, practice })).print.headerText).toBe('Sunrise Multispeciality')
    expect(resolveBrand(env, snap({}, { billing, practice })).print.headerText).toBe('Sunrise Healthcare Pvt Ltd')
    expect(resolveBrand(env, snap({}, { practice })).print.headerText).toBe('Sunrise Clinic')
    expect(resolveBrand(env, snap({})).print.headerText).toBe('Env Hospital Pvt Ltd')
    const full = resolveBrand(env, snap({ printFooterText: 'Thank you', printSignatureLine: 'Medical Superintendent' }, { billing, practice })).print
    expect(full).toMatchObject({
      subline: '12 MG Road, Pune', footerText: 'Thank you', signatureLine: 'Medical Superintendent',
      address: '12 MG Road, Pune', gstin: '27ABCDE1234F1Z5', rohiniId: 'R123', hfrId: 'IN2710000001',
    })
    expect(resolveBrand(env, snap({}, { practice })).print.subline).toBe('Pune, Maharashtra')
  })

  it('maps asset rows to content-addressed /branding paths and never leaks a blob URL', () => {
    const light = SHA('a')
    const dark = SHA('b')
    expect(brandAssetPath('logo_light', light)).toBe(`/branding/logo-light-${'a'.repeat(16)}.png`)
    expect(brandAssetPath('icon_512', SHA('c'))).toBe(`/branding/icon-512-${'c'.repeat(16)}.png`)
    const s = snap({}, { assets: [asset('logo_light', light), asset('logo_dark', dark), asset('icon_32', SHA('d'))] })
    const b = resolveBrand(loadBrand({ BRAND_LOGO_URL: 'https://cdn.example/logo.png' }), s)
    expect(b.logoUrl).toBe(`/branding/logo-light-${'a'.repeat(16)}.png`)
    expect(b.logoDarkUrl).toBe(`/branding/logo-dark-${'b'.repeat(16)}.png`)
    expect(b.print.logoUrl).toBe(b.logoUrl)
    const json = JSON.stringify(b)
    expect(json).not.toContain('local://')
    expect(json).not.toContain('secret-store')
    expect(json).not.toContain(light)
  })

  it('logo: uploaded light logo, then DB logoUrl (validated like BRAND_LOGO_URL), then env', () => {
    const env = loadBrand({ BRAND_LOGO_URL: 'https://cdn.example/env.png' })
    expect(resolveBrand(env, snap({ logoUrl: 'https://cdn.example/db.png' })).logoUrl).toBe('https://cdn.example/db.png')
    expect(resolveBrand(env, snap({ logoUrl: '/logos/db.png' })).logoUrl).toBe('/logos/db.png')
    expect(resolveBrand(env, snap({ logoUrl: 'javascript:alert(1)' })).logoUrl).toBe('https://cdn.example/env.png')
    expect(resolveBrand(env, snap({ logoUrl: 'http://cdn.example/db.png' })).logoUrl).toBe('https://cdn.example/env.png')
    expect(resolveBrand(env, snap({ logoUrl: 'https://cdn.example/db.png' }, { assets: [asset('logo_light', SHA('e'))] })).logoUrl)
      .toBe(`/branding/logo-light-${'e'.repeat(16)}.png`)
    expect(resolveBrand(env, snap()).logoUrl).toBe('https://cdn.example/env.png')
  })

  it('ignores an asset row whose hash is malformed', () => {
    const b = resolveBrand(loadBrand({}), snap({}, { assets: [asset('logo_light', 'not-a-hash')] }))
    expect(b.logoUrl).toBeNull()
  })

  it('accent: DB colour, else BRAND_PRIMARY_COLOR, else null', () => {
    expect(resolveBrand(loadBrand({ BRAND_PRIMARY_COLOR: '#0a7d5a' }), snap({ accentColor: '#7a1f5c' })).accent).toEqual(deriveAccentPalette('#7a1f5c'))
    expect(resolveBrand(loadBrand({ BRAND_PRIMARY_COLOR: '#0a7d5a' }), snap({ accentColor: '#7a1f5c' })).primaryColor).toBe('#7a1f5c')
    expect(resolveBrand(loadBrand({ BRAND_PRIMARY_COLOR: '#0a7d5a' }), snap()).accent).toEqual(deriveAccentPalette('#0a7d5a'))
    expect(resolveBrand(loadBrand({}), snap()).accent).toBeNull()
    expect(resolveBrand(loadBrand({}), snap({ accentColor: 'red;}' })).accent).toBeNull()
    expect(loadBrand({ BRAND_PRIMARY_COLOR: '#abc' }).accent).toEqual(deriveAccentPalette('#aabbcc'))
  })

  it('MFA issuer, system sender and SMS name follow the resolved name', () => {
    const b = resolveBrand(loadBrand(ENV), snap({ displayName: 'Sunrise: Hospital' }))
    expect(b.mfaIssuer).toBe('Sunrise Hospital')
    expect(b.systemSenderName).toBe('Sunrise: Hospital (Automated)')
    expect(b.smsName).toBe('Sunrise: Hospital')
    expect(resolveBrand(loadBrand(ENV), snap({ displayName: 'Sunrise', smsName: 'SUNRISE' })).smsName).toBe('SUNRISE')
  })

  it('cookie prefix always stays the env value', () => {
    const env = loadBrand({ BRAND_COOKIE_PREFIX: 'acme' })
    const forged = snap({ displayName: 'X' }) as BrandSnapshot & { settings: { cookiePrefix: string } }
    ;(forged.settings as unknown as Record<string, unknown>).cookiePrefix = 'evil'
    expect(resolveBrand(env, forged).cookiePrefix).toBe('acme')
  })

  it('login quote: DB quote with only its own attribution, else the env/default quote wholesale', () => {
    const env = loadBrand({ BRAND_LOGIN_QUOTE: 'Env words', BRAND_LOGIN_QUOTE_ATTRIBUTION: 'Env person' })
    expect(resolveBrand(env, snap({ loginQuote: 'Healing together.', loginQuoteAttribution: null })).loginQuote).toEqual({ text: 'Healing together.', attribution: null })
    expect(resolveBrand(env, snap({ loginQuote: 'Healing together.', loginQuoteAttribution: 'Founders' })).loginQuote).toEqual({ text: 'Healing together.', attribution: 'Founders' })
    expect(resolveBrand(env, snap({ loginQuote: null, loginQuoteAttribution: 'Founders' })).loginQuote).toEqual({ text: 'Env words', attribution: 'Env person' })
  })

  it('carries the department-list toggle and the email signature (newlines kept)', () => {
    const b = resolveBrand(loadBrand({}), snap({ loginShowDepartmentList: false, emailSignature: 'Sunrise Hospital\nPune\u0007' }))
    expect(b.login).toEqual({ showDepartmentList: false })
    expect(b.emailSignature).toBe('Sunrise Hospital\nPune')
  })
})

describe('toPublicBrand', () => {
  it('has exactly the PublicBrand keys and no server-only values', () => {
    const b = resolveBrand(loadBrand(ENV), snap({ displayName: 'Sunrise' }, { assets: [asset('logo_light', SHA('a'))] }))
    const p = toPublicBrand(b)
    expect(Object.keys(p).sort()).toEqual(
      ['login', 'loginQuote', 'logoDarkUrl', 'logoUrl', 'name', 'portalName', 'supportEmail', 'supportPhone', 'tagline'].sort(),
    )
    expect(p.name).toBe('Sunrise')
    expect(JSON.stringify(p)).not.toContain('local://')
  })
})
