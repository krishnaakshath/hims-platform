import { describe, it, expect } from 'vitest'
import { brandOnboardingStatus } from '@/lib/brand-resolve'
import type { BrandSnapshot } from '@/lib/brand-snapshot'

function snap(settings: Partial<BrandSnapshot['settings']> = {}, assets: BrandSnapshot['assets'] = []): BrandSnapshot {
  return {
    settings: {
      id: 1, revision: 1, displayName: null, tagline: null, supportEmail: null, supportPhone: null, accentColor: null, logoUrl: null,
      loginQuote: null, loginQuoteAttribution: null, loginShowDepartmentList: true, portalName: null, printHeaderText: null,
      printFooterText: null, printSignatureLine: null, emailSignature: null, smsName: null, onboardingTestSigninAt: null,
      onboardingDismissedAt: null, updatedAt: '2026-10-23T00:00:00.000Z', updatedByName: null, ...settings,
    },
    assets, billing: null, practice: null,
  }
}
const lightLogo = {
  kind: 'logo_light', source: 'upload', blobUrl: 'local://x', sha256: 'a'.repeat(64), contentType: 'image/png',
  width: 100, height: 100, byteSize: 10, createdAt: '2026-10-23T00:00:00.000Z', createdByName: 'A',
} as BrandSnapshot['assets'][number]

describe('brandOnboardingStatus', () => {
  it('empty snapshot is 0 of 5, incomplete, not dismissed', () => {
    const s = brandOnboardingStatus(snap())
    expect(s.items.map((i) => i.key)).toEqual(['name', 'logo', 'colour', 'contact', 'signin'])
    expect(s.items.every((i) => !i.done)).toBe(true)
    expect(s.complete).toBe(false)
    expect(s.dismissed).toBe(false)
  })
  it('hrefs', () => {
    const h = Object.fromEntries(brandOnboardingStatus(snap()).items.map((i) => [i.key, i.href]))
    expect(h).toEqual({
      name: '/settings/branding#identity', logo: '/settings/branding#logo', colour: '/settings/branding#colour',
      contact: '/settings/branding#contact', signin: '/login',
    })
  })
  it('all done is complete', () => {
    const s = brandOnboardingStatus(snap(
      { displayName: 'Care', accentColor: '#0a7d5a', supportPhone: '+91 98765 43210', onboardingTestSigninAt: '2026-10-23T01:00:00.000Z' },
      [lightLogo],
    ))
    expect(s.items.every((i) => i.done)).toBe(true)
    expect(s.complete).toBe(true)
  })
  it('stored logoUrl or support email count', () => {
    const s = brandOnboardingStatus(snap({ logoUrl: 'https://x.example/l.png', supportEmail: 'a@b.example' }))
    const d = Object.fromEntries(s.items.map((i) => [i.key, i.done]))
    expect(d.logo).toBe(true)
    expect(d.contact).toBe(true)
  })
  it('dark logo alone does not count', () => {
    const s = brandOnboardingStatus(snap({}, [{ ...lightLogo, kind: 'logo_dark' }]))
    expect(s.items.find((i) => i.key === 'logo')!.done).toBe(false)
  })
  it('dismissed follows onboardingDismissedAt', () => {
    expect(brandOnboardingStatus(snap({ onboardingDismissedAt: '2026-10-23T01:00:00.000Z' })).dismissed).toBe(true)
  })
})
