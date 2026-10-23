import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { Session } from '@/lib/auth'
import type { BrandSettingsInput } from '@/lib/brand-snapshot'

// WL T3: brand settings queries. Every test that writes the singleton resets it in afterEach.
describe.skipIf(!process.env.DATABASE_URL)('brand settings queries (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const ACTOR = `TEST-WL-${RUN}`
  const session: Session = { role: 'admin', name: ACTOR, userId: null }
  let savedGstin: string | null | undefined

  const mods = async () => ({
    ...(await import('@/db/client')), ...(await import('@/db/schema')), ...(await import('drizzle-orm')),
    q: await import('@/lib/queries/brand-settings'),
  })

  const blank = (over: Partial<BrandSettingsInput> = {}): BrandSettingsInput => ({
    displayName: null, tagline: null, supportEmail: null, supportPhone: null, accentColor: null, logoUrl: null,
    loginQuote: null, loginQuoteAttribution: null, loginShowDepartmentList: true, portalName: null, printHeaderText: null,
    printFooterText: null, printSignatureLine: null, emailSignature: null, smsName: null, ...over,
  })

  const asset = (sha = 'b'.repeat(64)) => ({ source: 'upload' as const, blobUrl: `local:branding/test-${RUN}.png`, sha256: sha, width: 400, height: 100, byteSize: 1234 })

  beforeAll(async () => {
    const { getDb, billingSettings, eq } = await mods()
    const [row] = await getDb().select({ gstin: billingSettings.gstin }).from(billingSettings).where(eq(billingSettings.id, 1))
    savedGstin = row ? row.gstin : undefined
  })

  afterEach(async () => {
    const { q } = await mods()
    await q.resetBrandSettings(null)
  })

  afterAll(async () => {
    const { getDb, billingSettings, auditLog, eq } = await mods()
    if (savedGstin !== undefined) await getDb().update(billingSettings).set({ gstin: savedGstin }).where(eq(billingSettings.id, 1))
    await getDb().delete(auditLog).where(eq(auditLog.userName, ACTOR))
  })

  const auditRows = async () => {
    const { getDb, auditLog, eq, asc } = await mods()
    return getDb().select({ action: auditLog.action, details: auditLog.details }).from(auditLog).where(eq(auditLog.userName, ACTOR)).orderBy(asc(auditLog.id))
  }

  it('updateBrandSettings at revision 0 bumps to 1 and audits field names only', async () => {
    const { q } = await mods()
    const before = (await auditRows()).length
    const r = await q.updateBrandSettings(blank({ displayName: 'Sunrise Multispeciality Hospital', tagline: 'Care close to home' }), 0, session)
    expect(r).toEqual({ ok: true, revision: 1, changed: ['displayName', 'tagline'] })
    const s = await q.getBrandSettings()
    expect(s.displayName).toBe('Sunrise Multispeciality Hospital')
    expect(s.tagline).toBe('Care close to home')
    expect(s.revision).toBe(1)
    expect(s.updatedByName).toBe(ACTOR)
    const audits = (await auditRows()).slice(before)
    expect(audits).toEqual([{ action: 'branding: updated settings', details: 'fields=displayName,tagline' }])
  })

  it('a second call with the stale revision 0 is a revision_conflict and changes nothing', async () => {
    const { q } = await mods()
    await q.updateBrandSettings(blank({ displayName: 'Sunrise Multispeciality Hospital', tagline: 'Care close to home' }), 0, session)
    const before = (await auditRows()).length
    const r = await q.updateBrandSettings(blank({ displayName: 'Other name' }), 0, session)
    expect(r).toEqual({ ok: false, error: 'revision_conflict' })
    const s = await q.getBrandSettings()
    expect(s.displayName).toBe('Sunrise Multispeciality Hospital')
    expect(s.revision).toBe(1)
    expect((await auditRows()).length).toBe(before)
  })

  it('loadBrandSnapshot is JSON-safe (ISO strings) and carries billing and practice details', async () => {
    const { q, getDb, billingSettings, eq } = await mods()
    await getDb().update(billingSettings).set({ gstin: '29ABCDE1234F1Z5' }).where(eq(billingSettings.id, 1))
    await q.updateBrandSettings(blank({ displayName: 'Sunrise' }), 0, session)
    await q.putBrandAsset('logo_light', asset(), session)
    await q.recordOnboarding('dismiss', session)
    const s = await q.loadBrandSnapshot()
    expect(JSON.parse(JSON.stringify(s))).toEqual(s)
    expect(typeof s.settings.updatedAt).toBe('string')
    expect(typeof s.settings.onboardingDismissedAt).toBe('string')
    expect(s.settings.onboardingTestSigninAt).toBeNull()
    expect(s.assets.map((a) => [a.kind, typeof a.createdAt])).toEqual([['logo_light', 'string']])
    expect(s.billing?.gstin).toBe('29ABCDE1234F1Z5')
    expect(s.settings.displayName).toBe('Sunrise')
    expect(s.practice === null || 'practiceName' in s.practice).toBe(true)
  })

  it('resetBrandSettings nulls every editable key, shows the department list and deletes every asset', async () => {
    const { q, getDb, brandAssets } = await mods()
    const all = blank({
      displayName: 'Sunrise', tagline: 'Care', supportEmail: 'help@sunrise.in', supportPhone: '+91 80 4000 1234', accentColor: '#0a7c86',
      logoUrl: 'https://cdn.sunrise.in/logo.png', loginQuote: 'Seva', loginQuoteAttribution: 'Founder', loginShowDepartmentList: false,
      portalName: 'Sunrise Patient Portal', printHeaderText: 'Sunrise', printFooterText: 'Thank you', printSignatureLine: 'Medical Superintendent',
      emailSignature: 'Sunrise\nBengaluru', smsName: 'SUNRSE',
    })
    const u = await q.updateBrandSettings(all, 0, session)
    expect(u.ok && u.changed.length).toBe(15)
    await q.putBrandAsset('logo_light', asset(), session)
    await q.putBrandAsset('icon_32', { ...asset('c'.repeat(64)), source: 'derived' }, session)
    const before = (await auditRows()).length
    const r = await q.resetBrandSettings(session)
    expect(r.revision).toBe(2)
    const s = await q.getBrandSettings()
    for (const k of q.BRAND_EDITABLE_KEYS) {
      if (k === 'loginShowDepartmentList') expect(s[k]).toBe(true)
      else expect(s[k], k).toBeNull()
    }
    expect(await getDb().select().from(brandAssets)).toEqual([])
    expect((await auditRows()).slice(before)).toEqual([{ action: 'branding: reset to defaults', details: null }])
  })

  // WL T6: the admin reset carries the revision it was confirmed against.
  it('resetBrandSettingsAt with a stale revision changes nothing and writes no audit row', async () => {
    const { q, getDb, brandAssets } = await mods()
    await q.updateBrandSettings(blank({ displayName: 'Sunrise' }), 0, session)
    await q.putBrandAsset('logo_light', asset(), session)
    const before = (await auditRows()).length
    expect(await q.resetBrandSettingsAt(0, session)).toEqual({ ok: false, error: 'revision_conflict' })
    const s = await q.getBrandSettings()
    expect([s.displayName, s.revision]).toEqual(['Sunrise', 1])
    expect((await getDb().select().from(brandAssets)).length).toBe(1)
    expect((await auditRows()).length).toBe(before)
  })

  it('resetBrandSettingsAt with the current revision resets, advances the revision and audits', async () => {
    const { q } = await mods()
    await q.updateBrandSettings(blank({ displayName: 'Sunrise' }), 0, session)
    const before = (await auditRows()).length
    expect(await q.resetBrandSettingsAt(1, session)).toEqual({ ok: true, revision: 2 })
    expect((await q.getBrandSettings()).displayName).toBeNull()
    expect((await auditRows()).slice(before)).toEqual([{ action: 'branding: reset to defaults', details: null }])
  })

  // WL T6: the admin screen payload never carries a blob URL.
  it('getBrandingAdminPayload maps assets to hash paths and carries no blob URL', async () => {
    const { q } = await mods()
    await q.putBrandAsset('logo_light', asset(), session)
    const p = await q.getBrandingAdminPayload()
    expect(JSON.stringify(p)).not.toMatch(/blob_?url|local:/i)
    expect(p.assets).toEqual([{ kind: 'logo_light', path: `/branding/logo-light-${'b'.repeat(16)}.png`, width: 400, height: 100, source: 'upload' }])
    expect(p.revision).toBe(0)
    expect(p.palette).toBeNull()
  })

  it('resetBrandSettings(null) restores the pristine singleton without an audit row', async () => {
    const { q } = await mods()
    await q.updateBrandSettings(blank({ displayName: 'Sunrise' }), 0, session)
    const before = (await auditRows()).length
    expect(await q.resetBrandSettings(null)).toEqual({ revision: 0 })
    const s = await q.getBrandSettings()
    expect(s.revision).toBe(0)
    expect(s.displayName).toBeNull()
    expect((await auditRows()).length).toBe(before)
  })

  it('getBrandAssetForServe is null before an upload and returns only blobUrl and sha256 after', async () => {
    const { q } = await mods()
    expect(await q.getBrandAssetForServe('logo_light')).toBeNull()
    await q.putBrandAsset('logo_light', asset(), session)
    expect(await q.getBrandAssetForServe('logo_light')).toEqual({ blobUrl: `local:branding/test-${RUN}.png`, sha256: 'b'.repeat(64) })
    // Replacing the asset overwrites the row (kind is the key).
    await q.putBrandAsset('logo_light', { ...asset('d'.repeat(64)) }, session)
    expect((await q.getBrandAssetForServe('logo_light'))?.sha256).toBe('d'.repeat(64))
  })

  it('putBrandAsset and deleteBrandAssets audit without blob URLs; inside a caller tx the caller audits', async () => {
    const { q, getDb } = await mods()
    const before = (await auditRows()).length
    await q.putBrandAsset('logo_dark', asset(), session)
    await q.deleteBrandAssets(['logo_dark', 'icon_32'], session)
    await getDb().transaction(async (tx) => {
      await q.putBrandAsset('icon_512', { ...asset(), source: 'derived' }, session, tx)
      await q.deleteBrandAssets(['icon_512'], session, tx)
    })
    const audits = (await auditRows()).slice(before)
    expect(audits).toEqual([
      { action: 'branding: stored asset', details: 'kind=logo_dark source=upload bytes=1234 w=400 h=100' },
      { action: 'branding: removed asset', details: 'kinds=logo_dark,icon_32' },
    ])
    expect(await q.getBrandAssetForServe('logo_dark')).toBeNull()
  })

  it('recordOnboarding stamps the time and audits the action', async () => {
    const { q } = await mods()
    const before = (await auditRows()).length
    await q.recordOnboarding('test_signin_done', session)
    const s = await q.getBrandSettings()
    expect(s.onboardingTestSigninAt).toBeInstanceOf(Date)
    expect(s.onboardingDismissedAt).toBeNull()
    expect((await auditRows()).slice(before)).toEqual([{ action: 'branding: onboarding', details: 'action=test_signin_done' }])
  })
})
