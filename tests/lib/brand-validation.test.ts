import { describe, it, expect } from 'vitest'
import {
  brandOnboardingSchema, brandResetSchema, brandSettingsSchema, brandValidationDetails,
} from '@/lib/brand-validation'

// WL T6: the strict Zod bodies of the admin branding routes (spec §3, §4.2, §6; lane ruling R2).

const BLANK = {
  revision: 0, displayName: null, tagline: null, supportEmail: null, supportPhone: null, accentColor: null, logoUrl: null,
  loginQuote: null, loginQuoteAttribution: null, loginShowDepartmentList: true, portalName: null, printHeaderText: null,
  printFooterText: null, printSignatureLine: null, emailSignature: null, smsName: null,
}
const parse = (over: Record<string, unknown>) => brandSettingsSchema.safeParse({ ...BLANK, ...over })

describe('brandSettingsSchema', () => {
  it('accepts the all-null body and returns every key', () => {
    const r = parse({})
    expect(r.success).toBe(true)
    expect(r.success && r.data).toEqual(BLANK)
  })

  it('rejects an unknown key', () => {
    expect(parse({ loginBackground: 'aurora' }).success).toBe(false)
    expect(parse({ blobUrl: 'local:x' }).success).toBe(false)
  })

  it('rejects a body missing an editable key or the revision', () => {
    const noTagline: Record<string, unknown> = { ...BLANK }
    delete noTagline.tagline
    expect(brandSettingsSchema.safeParse(noTagline).success).toBe(false)
    expect(parse({ revision: -1 }).success).toBe(false)
    expect(parse({ revision: 1.5 }).success).toBe(false)
  })

  it('collapses CR/LF header injection in the display name to one line', () => {
    const r = parse({ displayName: 'Sunrise Hospital\r\nBcc: someone@example.com' })
    expect(r.success && r.data.displayName).toBe('Sunrise Hospital Bcc: someone@example.com')
  })

  it('caps text at the spec length and turns blank text into null', () => {
    const r = parse({ displayName: 'a'.repeat(100), tagline: '   ', smsName: 'S'.repeat(45) })
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data.displayName).toHaveLength(60)
    expect(r.data.tagline).toBeNull()
    expect(r.data.smsName).toHaveLength(30)
  })

  it('rejects text far over the cap', () => {
    expect(parse({ displayName: 'a'.repeat(121) }).success).toBe(false)
  })

  it('stores markup verbatim as text', () => {
    const r = parse({ tagline: '<b>Hi</b>' })
    expect(r.success && r.data.tagline).toBe('<b>Hi</b>')
  })

  it('validates the accent colour and expands #rgb', () => {
    expect(parse({ accentColor: 'red' }).success).toBe(false)
    expect(parse({ accentColor: '#12345' }).success).toBe(false)
    const r = parse({ accentColor: '#ABC' })
    expect(r.success && r.data.accentColor).toBe('#aabbcc')
    const r2 = parse({ accentColor: '' })
    expect(r2.success && r2.data.accentColor).toBeNull()
  })

  it('validates the support email and phone', () => {
    expect(parse({ supportEmail: 'not an email' }).success).toBe(false)
    expect(parse({ supportEmail: 'a@b.in\r\nBcc: x@y.in' }).success).toBe(false)
    const ok = parse({ supportEmail: ' help@sunrise.in ', supportPhone: '+91 80 4000 1234' })
    expect(ok.success && [ok.data.supportEmail, ok.data.supportPhone]).toEqual(['help@sunrise.in', '+91 80 4000 1234'])
    expect(parse({ supportPhone: 'call us' }).success).toBe(false)
    expect(parse({ supportPhone: '12' }).success).toBe(false)
  })

  it('validates the logo URL like BRAND_LOGO_URL', () => {
    expect(parse({ logoUrl: 'http://x/a.png' }).success).toBe(false)
    expect(parse({ logoUrl: 'javascript:alert(1)' }).success).toBe(false)
    expect(parse({ logoUrl: 'https://u:p@x/a.png' }).success).toBe(false)
    expect(parse({ logoUrl: '//evil.example/a.png' }).success).toBe(false)
    const a = parse({ logoUrl: 'https://cdn.example/a.png' })
    expect(a.success && a.data.logoUrl).toBe('https://cdn.example/a.png')
    const b = parse({ logoUrl: '/logo.png' })
    expect(b.success && b.data.logoUrl).toBe('/logo.png')
  })

  it('keeps up to four email signature lines and rejects more', () => {
    const r = parse({ emailSignature: 'Sunrise Hospital\r\nMG Road\nBengaluru\u0007\nPh 080 4000 1234' })
    expect(r.success && r.data.emailSignature).toBe('Sunrise Hospital\nMG Road\nBengaluru\nPh 080 4000 1234')
    expect(parse({ emailSignature: ['1', '2', '3', '4', '5', '6'].join('\n') }).success).toBe(false)
  })

  it('requires a boolean for the department list toggle', () => {
    expect(parse({ loginShowDepartmentList: 'yes' }).success).toBe(false)
    expect(parse({ loginShowDepartmentList: null }).success).toBe(false)
    const r = parse({ loginShowDepartmentList: false })
    expect(r.success && r.data.loginShowDepartmentList).toBe(false)
  })

  it('details name known fields and authored messages only, never the input', () => {
    const r = parse({ accentColor: 'red', supportEmail: 'nope', 'evil<script>': 1 })
    expect(r.success).toBe(false)
    if (r.success) return
    const details = brandValidationDetails(r.error)
    expect(details).toEqual(expect.arrayContaining([
      { field: 'accentColor', message: expect.any(String) },
      { field: 'supportEmail', message: expect.any(String) },
      { field: null, message: 'Invalid value' },
    ]))
    expect(JSON.stringify(details)).not.toMatch(/evil|nope|red/)
  })
})

describe('brandResetSchema', () => {
  it('requires confirm RESET and a revision', () => {
    expect(brandResetSchema.safeParse({ confirm: 'RESET', revision: 3 }).success).toBe(true)
    expect(brandResetSchema.safeParse({ confirm: 'reset', revision: 3 }).success).toBe(false)
    expect(brandResetSchema.safeParse({ revision: 3 }).success).toBe(false)
    expect(brandResetSchema.safeParse({ confirm: 'RESET' }).success).toBe(false)
    expect(brandResetSchema.safeParse({ confirm: 'RESET', revision: 3, extra: 1 }).success).toBe(false)
  })
})

describe('brandOnboardingSchema', () => {
  it('accepts only the two actions', () => {
    expect(brandOnboardingSchema.safeParse({ action: 'dismiss' }).success).toBe(true)
    expect(brandOnboardingSchema.safeParse({ action: 'test_signin_done' }).success).toBe(true)
    expect(brandOnboardingSchema.safeParse({ action: 'other' }).success).toBe(false)
    expect(brandOnboardingSchema.safeParse({ action: 'dismiss', x: 1 }).success).toBe(false)
  })
})
