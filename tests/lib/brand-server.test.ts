// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// WL T4: getBrand caches the snapshot under the 'brand-settings' tag, never throws, and never
// caches a failure (the error is caught outside the cached function).

const cacheCalls: { keyParts: unknown; options: unknown }[] = []
const revalidateTag = vi.fn()
const loadBrandSnapshot = vi.fn()

beforeEach(() => {
  cacheCalls.length = 0
  revalidateTag.mockReset()
  loadBrandSnapshot.mockReset()
  vi.resetModules()
  vi.doMock('next/cache', () => ({
    unstable_cache: (fn: () => Promise<unknown>, keyParts: unknown, options: unknown) => {
      cacheCalls.push({ keyParts, options })
      return fn
    },
    revalidateTag,
  }))
  vi.doMock('@/lib/queries/brand-settings', () => ({ loadBrandSnapshot }))
  for (const k of ['BRAND_NAME', 'BRAND_PRIMARY_COLOR']) vi.stubEnv(k, '')
})

afterEach(() => {
  vi.doUnmock('next/cache')
  vi.doUnmock('@/lib/queries/brand-settings')
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

const pristine = (displayName: string | null) => ({
  settings: {
    id: 1, revision: 1, displayName, tagline: null, supportEmail: null, supportPhone: null, accentColor: null, logoUrl: null,
    loginQuote: null, loginQuoteAttribution: null, loginShowDepartmentList: true, portalName: null, printHeaderText: null,
    printFooterText: null, printSignatureLine: null, emailSignature: null, smsName: null, onboardingTestSigninAt: null,
    onboardingDismissedAt: null, updatedAt: '2026-10-23T00:00:00.000Z', updatedByName: null,
  },
  assets: [], billing: null, practice: null,
})

describe('brand-server', () => {
  it('caches the snapshot under the brand-settings tag with a 300 s safety net', async () => {
    const mod = await import('@/lib/brand-server')
    expect(mod.BRAND_CACHE_TAG).toBe('brand-settings')
    expect(cacheCalls).toEqual([{ keyParts: ['brand-settings-v1'], options: { tags: ['brand-settings'], revalidate: 300 } }])
  })

  it('resolves the stored brand over env', async () => {
    loadBrandSnapshot.mockResolvedValue(pristine('Sunrise Hospital'))
    const { getBrand, getPublicBrand } = await import('@/lib/brand-server')
    expect((await getBrand()).name).toBe('Sunrise Hospital')
    expect((await getPublicBrand()).name).toBe('Sunrise Hospital')
  })

  it('falls back to the env brand when the read fails, logging only the error class', async () => {
    vi.stubEnv('BRAND_NAME', 'Env Hospital')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadBrandSnapshot.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'))
    const { getBrand } = await import('@/lib/brand-server')
    const { envBrand } = await import('@/lib/brand')
    const b = await getBrand()
    expect(b.name).toBe('Env Hospital')
    expect(b).toEqual(envBrand)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[brand] settings read failed (Error)')
  })

  it('warns at most once a minute and recovers on the next successful read (failures are not cached)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    loadBrandSnapshot.mockRejectedValue(new TypeError('x'))
    const { getBrand } = await import('@/lib/brand-server')
    await getBrand()
    await getBrand()
    expect(warn).toHaveBeenCalledTimes(1)
    now.mockReturnValue(1_000_000 + 61_000)
    await getBrand()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenLastCalledWith('[brand] settings read failed (TypeError)')
    loadBrandSnapshot.mockResolvedValue(pristine('Recovered Hospital'))
    expect((await getBrand()).name).toBe('Recovered Hospital')
  })

  it('getBrandAssetRow reads the cached snapshot and warns (throttled) when it fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const asset = { kind: 'icon_32', blobUrl: 'local://x', sha256: 'a'.repeat(64) }
    loadBrandSnapshot.mockResolvedValueOnce({ ...pristine(null), assets: [asset] })
    const { getBrandAssetRow } = await import('@/lib/brand-server')
    expect(await getBrandAssetRow('icon_32')).toEqual({ blobUrl: 'local://x', sha256: 'a'.repeat(64) })
    expect(await getBrandAssetRow('icon_512')).toBeNull()
    loadBrandSnapshot.mockRejectedValue(new TypeError('x local://x'))
    expect(await getBrandAssetRow('icon_32')).toBeNull()
    expect(await getBrandAssetRow('icon_32')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[brand] settings read failed (TypeError)')
  })

  it('invalidateBrandCache expires the tag immediately', async () => {
    const { invalidateBrandCache } = await import('@/lib/brand-server')
    invalidateBrandCache()
    expect(revalidateTag).toHaveBeenCalledWith('brand-settings', { expire: 0 })
  })
})
