// @vitest-environment node
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'
import { ALL_ROLES } from '@/lib/role-policy'

// WL T6: the admin branding settings API (spec §4.2, §6). Gate tests need no DB; the write tests
// run against the isolated test DB and reset the singleton after each test.

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const ACTOR = `TEST-WL6-${RUN}`
let role: Role = 'admin'

const { revalidateTag } = vi.hoisted(() => ({ revalidateTag: vi.fn() }))
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => Promise<unknown>) => fn, revalidateTag }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role, name: ACTOR, userId: null })) }
})

import { GET, PUT } from '@/app/api/settings/branding/route'
import { POST as postReset } from '@/app/api/settings/branding/reset/route'
import { POST as postOnboarding } from '@/app/api/settings/branding/onboarding/route'

const URL_BASE = 'http://localhost'
const send = (method: 'PUT' | 'POST', path: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`${URL_BASE}${path}`, { method, body: typeof body === 'string' ? body : JSON.stringify(body), headers })

const BLANK = {
  displayName: null, tagline: null, supportEmail: null, supportPhone: null, accentColor: null, logoUrl: null,
  loginQuote: null, loginQuoteAttribution: null, loginShowDepartmentList: true, portalName: null, printHeaderText: null,
  printFooterText: null, printSignatureLine: null, emailSignature: null, smsName: null,
}

afterEach(() => {
  role = 'admin'
  revalidateTag.mockReset()
})

describe('branding routes deny every non-admin role before reading the body', () => {
  const denied = ALL_ROLES.filter((r) => r !== 'admin')

  it('includes pi among the denied roles', () => {
    expect(denied).toContain('pi')
  })

  it.each(denied)('%s gets 403 from GET, PUT, reset and onboarding, even with a bad JSON body', async (r) => {
    role = r
    const responses = [
      await GET(),
      await PUT(send('PUT', '/api/settings/branding', { ...BLANK, revision: 0 })),
      await PUT(send('PUT', '/api/settings/branding', '{not json')),
      await postReset(send('POST', '/api/settings/branding/reset', { confirm: 'RESET', revision: 0 })),
      await postReset(send('POST', '/api/settings/branding/reset', '{not json')),
      await postOnboarding(send('POST', '/api/settings/branding/onboarding', { action: 'dismiss' })),
      await postOnboarding(send('POST', '/api/settings/branding/onboarding', '{not json')),
    ]
    for (const res of responses) {
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('admin with a bad JSON body gets 400 Invalid JSON', async () => {
    for (const res of [
      await PUT(send('PUT', '/api/settings/branding', '{not json')),
      await postReset(send('POST', '/api/settings/branding/reset', '{not json')),
      await postOnboarding(send('POST', '/api/settings/branding/onboarding', '{not json')),
    ]) {
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid JSON' })
    }
  })

  it('reset rejects a cross-origin request before the body is read', async () => {
    const res = await postReset(send('POST', '/api/settings/branding/reset', '{not json', { origin: 'https://evil.example' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Cross-origin request rejected' })
  })
})

describe.skipIf(!process.env.DATABASE_URL)('branding routes (DB)', () => {
  const mods = async () => ({
    ...(await import('@/db/client')), ...(await import('@/db/schema')), ...(await import('drizzle-orm')),
    q: await import('@/lib/queries/brand-settings'),
  })

  afterEach(async () => {
    const { q } = await mods()
    await q.resetBrandSettings(null)
  })

  afterAll(async () => {
    const { getDb, auditLog, eq } = await mods()
    await getDb().delete(auditLog).where(eq(auditLog.userName, ACTOR))
  })

  const auditRows = async () => {
    const { getDb, auditLog, eq, asc } = await mods()
    return getDb().select({ action: auditLog.action, details: auditLog.details }).from(auditLog).where(eq(auditLog.userName, ACTOR)).orderBy(asc(auditLog.id))
  }

  const put = (body: unknown) => PUT(send('PUT', '/api/settings/branding', body))

  it('admin PUT saves, bumps the revision, invalidates the cache once and audits field names only', async () => {
    const before = (await auditRows()).length
    const res = await put({ ...BLANK, revision: 0, displayName: 'Sunrise Hospital\r\nBcc: x@y.in', accentColor: '#ABC', tagline: '<b>Hi</b>' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, revision: 1 })
    expect(revalidateTag).toHaveBeenCalledTimes(1)
    expect(revalidateTag).toHaveBeenCalledWith('brand-settings', { expire: 0 })
    const audits = (await auditRows()).slice(before)
    expect(audits).toEqual([{ action: 'branding: updated settings', details: 'fields=displayName,tagline,accentColor' }])
    const { q } = await mods()
    const s = await q.getBrandSettings()
    expect([s.displayName, s.accentColor, s.tagline]).toEqual(['Sunrise Hospital Bcc: x@y.in', '#aabbcc', '<b>Hi</b>'])
  })

  it('a stale revision is a 409 revision_conflict with no write, no audit and no invalidation', async () => {
    expect((await put({ ...BLANK, revision: 0, displayName: 'Sunrise' })).status).toBe(200)
    revalidateTag.mockReset()
    const before = (await auditRows()).length
    const res = await put({ ...BLANK, revision: 0, displayName: 'Other' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Branding was changed by someone else. Reload to see their changes.', code: 'revision_conflict' })
    expect((await auditRows()).length).toBe(before)
    expect(revalidateTag).not.toHaveBeenCalled()
    const { q } = await mods()
    expect((await q.getBrandSettings()).displayName).toBe('Sunrise')
  })

  it('an invalid body is a 400 with field details and no write', async () => {
    for (const body of [
      { ...BLANK, revision: 0, loginBackground: 'video' },
      { ...BLANK, revision: 0, accentColor: 'red' },
      { ...BLANK, revision: 0, logoUrl: 'http://x/a.png' },
      { ...BLANK, revision: 0, logoUrl: 'javascript:alert(1)' },
      { ...BLANK, revision: 0, logoUrl: 'https://u:p@x/a.png' },
      { ...BLANK, revision: 0, emailSignature: '1\n2\n3\n4\n5\n6' },
    ]) {
      const res = await put(body)
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toBe('Invalid branding settings')
      expect(Array.isArray(json.details)).toBe(true)
      expect(JSON.stringify(json)).not.toMatch(/video|javascript|u:p@|http:\/\/x/)
    }
    expect(revalidateTag).not.toHaveBeenCalled()
    const { q } = await mods()
    expect((await q.getBrandSettings()).revision).toBe(0)
  })

  it('accepts an https or same-origin logo URL', async () => {
    expect((await put({ ...BLANK, revision: 0, logoUrl: 'https://cdn.example/a.png' })).status).toBe(200)
    expect((await put({ ...BLANK, revision: 1, logoUrl: '/logo.png' })).status).toBe(200)
    const { q } = await mods()
    expect((await q.getBrandSettings()).logoUrl).toBe('/logo.png')
  })

  it('GET returns settings, revision, hash-addressed assets, env defaults, linked billing and the palette, never a blob URL', async () => {
    const { q } = await mods()
    await put({ ...BLANK, revision: 0, displayName: 'Sunrise', accentColor: '#0a7c86' })
    await q.putBrandAsset('logo_light', { source: 'upload', blobUrl: `local:branding/test-${RUN}.png`, sha256: 'd'.repeat(64), width: 400, height: 100, byteSize: 1234 }, { role: 'admin', name: ACTOR, userId: null })
    const res = await GET()
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toMatch(/blob_?url|local:/i)
    const json = JSON.parse(text)
    expect(json.revision).toBe(1)
    expect(json.settings).toEqual({ ...BLANK, displayName: 'Sunrise', accentColor: '#0a7c86' })
    expect(json.assets).toEqual([{ kind: 'logo_light', path: `/branding/logo-light-${'d'.repeat(16)}.png`, width: 400, height: 100, source: 'upload' }])
    expect(Object.keys(json.defaults).sort()).toEqual(['accentColor', 'legalName', 'name', 'portalName', 'supportEmail', 'tagline'])
    expect(Object.keys(json.linked).sort()).toEqual(['address', 'gstin', 'hfrId', 'legalName', 'rohiniId'])
    expect(json.palette.input).toBe('#0a7c86')
    expect(json.palette.light.primary).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('GET palette is null without a stored accent', async () => {
    const json = await (await GET()).json()
    expect(json.palette).toBeNull()
    expect(json.assets).toEqual([])
  })

  it('reset without confirm RESET is a 400 and changes nothing', async () => {
    await put({ ...BLANK, revision: 0, displayName: 'Sunrise' })
    revalidateTag.mockReset()
    const res = await postReset(send('POST', '/api/settings/branding/reset', { revision: 1 }))
    expect(res.status).toBe(400)
    expect(revalidateTag).not.toHaveBeenCalled()
    const { q } = await mods()
    expect((await q.getBrandSettings()).displayName).toBe('Sunrise')
  })

  it('reset with a stale revision is a 409 with no write and no audit', async () => {
    await put({ ...BLANK, revision: 0, displayName: 'Sunrise' })
    revalidateTag.mockReset()
    const before = (await auditRows()).length
    const res = await postReset(send('POST', '/api/settings/branding/reset', { confirm: 'RESET', revision: 0 }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('revision_conflict')
    expect((await auditRows()).length).toBe(before)
    expect(revalidateTag).not.toHaveBeenCalled()
    const { q } = await mods()
    expect((await q.getBrandSettings()).displayName).toBe('Sunrise')
  })

  it('reset nulls every key, deletes the assets, audits and invalidates the cache', async () => {
    const { q, getDb, brandAssets } = await mods()
    await put({ ...BLANK, revision: 0, displayName: 'Sunrise', loginShowDepartmentList: false, smsName: 'SUNRSE' })
    await q.putBrandAsset('logo_light', { source: 'upload', blobUrl: `local:branding/test-${RUN}.png`, sha256: 'e'.repeat(64), width: 400, height: 100, byteSize: 1 }, { role: 'admin', name: ACTOR, userId: null })
    revalidateTag.mockReset()
    const before = (await auditRows()).length
    const res = await postReset(send('POST', '/api/settings/branding/reset', { confirm: 'RESET', revision: 1 }, { origin: URL_BASE }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, revision: 2 })
    expect(revalidateTag).toHaveBeenCalledWith('brand-settings', { expire: 0 })
    const s = await q.getBrandSettings()
    for (const k of q.BRAND_EDITABLE_KEYS) {
      if (k === 'loginShowDepartmentList') expect(s[k]).toBe(true)
      else expect(s[k], k).toBeNull()
    }
    expect(await getDb().select().from(brandAssets)).toEqual([])
    expect((await auditRows()).slice(before)).toEqual([{ action: 'branding: reset to defaults', details: null }])
  })

  it('onboarding dismiss sets onboarding_dismissed_at and invalidates the cache', async () => {
    const res = await postOnboarding(send('POST', '/api/settings/branding/onboarding', { action: 'dismiss' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(revalidateTag).toHaveBeenCalledWith('brand-settings', { expire: 0 })
    const { q } = await mods()
    const s = await q.getBrandSettings()
    expect(s.onboardingDismissedAt).toBeInstanceOf(Date)
    expect(s.onboardingTestSigninAt).toBeNull()
  })

  it('onboarding with an unknown action is a 400', async () => {
    const res = await postOnboarding(send('POST', '/api/settings/branding/onboarding', { action: 'skip' }))
    expect(res.status).toBe(400)
    expect(revalidateTag).not.toHaveBeenCalled()
  })
})
