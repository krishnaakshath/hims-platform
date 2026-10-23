// @vitest-environment node
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// The metadata routes read the brand per request (getBrand: stored settings over BRAND_* env), so
// each test stubs BRAND_* env, mocks the stored snapshot / asset rows, and re-imports the routes.
const loadBrandSnapshot = vi.fn()
const getPrivateBlobBytes = vi.fn()

beforeEach(() => {
  loadBrandSnapshot.mockReset().mockResolvedValue(null)
  getPrivateBlobBytes.mockReset().mockResolvedValue(null)
  vi.doMock('@/lib/queries/brand-settings', () => ({ loadBrandSnapshot }))
  vi.doMock('@/lib/blob-store', () => ({ getPrivateBlobBytes }))
})

async function load(env: Record<string, string>) {
  for (const k of ['BRAND_NAME', 'BRAND_PRIMARY_COLOR', 'BRAND_TAGLINE']) vi.stubEnv(k, '')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules()
  return {
    icon: await import('@/app/icon'),
    apple: await import('@/app/apple-icon'),
    manifest: (await import('@/app/manifest')).default,
  }
}

afterEach(() => {
  vi.doUnmock('@/lib/queries/brand-settings')
  vi.doUnmock('@/lib/blob-store')
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

const stored = (settings: Record<string, unknown>) => ({
  settings: {
    id: 1, revision: 1, displayName: null, tagline: null, supportEmail: null, supportPhone: null, accentColor: null, logoUrl: null,
    loginQuote: null, loginQuoteAttribution: null, loginShowDepartmentList: true, portalName: null, printHeaderText: null,
    printFooterText: null, printSignatureLine: null, emailSignature: null, smsName: null, onboardingTestSigninAt: null,
    onboardingDismissedAt: null, updatedAt: '2026-10-23T00:00:00.000Z', updatedByName: null, ...settings,
  },
  assets: [], billing: null, practice: null,
})

// A tiny distinguishable "PNG": the signature plus a marker; the route serves stored bytes as-is.
const STORED_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef])
const withAsset = (kind: string) => ({
  ...stored({}),
  assets: [{ kind, blobUrl: BLOB, sha256: 'a'.repeat(64), source: 'upload', width: 1, height: 1, byteSize: 1, createdAt: '2026-10-23T00:00:00.000Z' }],
})
const BLOB = 'local://brand/icon-secret.png'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

describe('icon routes', () => {
  it('declares 32/192/512 PNGs and an SVG', async () => {
    const { icon } = await load({})
    expect(icon.generateImageMetadata()).toEqual([
      { id: '32', contentType: 'image/png', size: { width: 32, height: 32 } },
      { id: '192', contentType: 'image/png', size: { width: 192, height: 192 } },
      { id: '512', contentType: 'image/png', size: { width: 512, height: 512 } },
      { id: 'svg', contentType: 'image/svg+xml' },
    ])
  })

  it.each(['32', '192', '512'])('/icon/%s returns a 200 PNG', async (id) => {
    const { icon } = await load({})
    const res = await icon.default({ id: Promise.resolve(id) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(bytes.slice(0, 4))).toEqual(PNG_MAGIC)
  })

  it('/icon/svg returns an SVG filled with the brand colour', async () => {
    const { icon } = await load({ BRAND_PRIMARY_COLOR: '#0b3d2e' })
    const res = await icon.default({ id: Promise.resolve('svg') })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^image\/svg\+xml/)
    const svg = await res.text()
    expect(svg).toContain('fill="#0b3d2e"')
    // White plus, heartbeat cut through it in the tile colour.
    expect(svg).toContain('fill="#ffffff"')
    expect(svg).toContain('stroke="#0b3d2e"')
  })

  it('/apple-icon returns a 200 180x180 PNG', async () => {
    const { apple } = await load({ BRAND_PRIMARY_COLOR: '#f5c518' })
    expect(apple.size).toEqual({ width: 180, height: 180 })
    const res = await apple.default()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(bytes.slice(0, 4))).toEqual(PNG_MAGIC)
    // IHDR width/height (big-endian at offsets 16 and 20).
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([180, 180])
  })
})

describe('manifest', () => {
  it('uses the brand name and colour', async () => {
    const { manifest } = await load({ BRAND_NAME: 'Saint Mary General Hospital', BRAND_PRIMARY_COLOR: '#0B3D2E' })
    const m = await manifest()
    expect(m.name).toBe('Saint Mary General Hospital')
    expect(m.short_name).toBe('Saint')
    expect(m.theme_color).toBe('#0b3d2e')
    expect(m.background_color).toBe('#0b3d2e')
    expect(m.icons?.map((i) => i.src)).toEqual(['/icon/192', '/icon/512', '/icon/svg', '/apple-icon'])
  })

  it('falls back to the product name and blue when the brand is unset', async () => {
    const { manifest } = await load({})
    const m = await manifest()
    expect(m.name).toBe('HIMS')
    expect(m.short_name).toBe('HIMS')
    expect(m.theme_color).toBe('#194f81')
  })
})

describe('stored brand (WL T4, lane ruling R3)', () => {
  it('tints the rendered SVG with the stored accent over BRAND_PRIMARY_COLOR', async () => {
    loadBrandSnapshot.mockResolvedValue(stored({ accentColor: '#7a1f5c' }))
    const { icon } = await load({ BRAND_PRIMARY_COLOR: '#0b3d2e' })
    const svg = await (await icon.default({ id: Promise.resolve('svg') })).text()
    expect(svg).toContain('fill="#7a1f5c"')
    expect(svg).not.toContain('#0b3d2e')
  })

  it.each([['32', 'icon_32'], ['192', 'icon_192'], ['512', 'icon_512']])('/icon/%s serves the stored %s PNG bytes', async (id, kind) => {
    loadBrandSnapshot.mockResolvedValue(withAsset(kind))
    getPrivateBlobBytes.mockResolvedValue(STORED_PNG)
    const { icon } = await load({})
    const res = await icon.default({ id: Promise.resolve(id) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(STORED_PNG)
    expect(getPrivateBlobBytes).toHaveBeenCalledWith(BLOB)
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('/icon/svg wraps the stored 512 PNG as a base64 data URI (never a user SVG, never the blob URL)', async () => {
    loadBrandSnapshot.mockResolvedValue(withAsset('icon_512'))
    getPrivateBlobBytes.mockResolvedValue(STORED_PNG)
    const { icon } = await load({})
    const res = await icon.default({ id: Promise.resolve('svg') })
    expect(res.headers.get('content-type')).toMatch(/^image\/svg\+xml/)
    const svg = await res.text()
    expect(svg).toContain(`href="data:image/png;base64,${Buffer.from(STORED_PNG).toString('base64')}"`)
    expect(svg).not.toContain('local://')
  })

  it('/apple-icon serves the stored icon_180', async () => {
    loadBrandSnapshot.mockResolvedValue(withAsset('icon_180'))
    getPrivateBlobBytes.mockResolvedValue(STORED_PNG)
    const { apple } = await load({})
    const res = await apple.default()
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(STORED_PNG)
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('falls back to the rendered icon when the asset read fails, logging the class name only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadBrandSnapshot.mockRejectedValue(new RangeError(`no such blob ${BLOB}`))
    const { icon, apple } = await load({})
    const res = await icon.default({ id: Promise.resolve('32') })
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(bytes.slice(0, 4))).toEqual(PNG_MAGIC)
    expect(bytes).not.toEqual(STORED_PNG)
    expect((await apple.default()).status).toBe(200)
    expect(warn).toHaveBeenCalledWith('[brand] settings read failed (RangeError)')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.flat().join(' ')).not.toContain('local://')
  })

  it('falls back to the render when the blob bytes are missing', async () => {
    loadBrandSnapshot.mockResolvedValue(withAsset('icon_512'))
    getPrivateBlobBytes.mockResolvedValue(null)
    const { icon } = await load({})
    const svg = await (await icon.default({ id: Promise.resolve('svg') })).text()
    expect(svg).toContain('fill="#194f81"')
  })

  it('names the manifest from the stored brand', async () => {
    loadBrandSnapshot.mockResolvedValue(stored({ displayName: 'Sunrise Hospital', tagline: 'Care close to home', accentColor: '#7a1f5c' }))
    const { manifest } = await load({ BRAND_NAME: 'Env Hospital' })
    const m = await manifest()
    expect(m).toMatchObject({ name: 'Sunrise Hospital', short_name: 'Sunrise', description: 'Care close to home', theme_color: '#7a1f5c' })
  })

  it.each(['icon.tsx', 'apple-icon.tsx', 'manifest.ts'])('%s renders per request (connection + comment)', (file) => {
    const src = readFileSync(path.join(process.cwd(), 'src/app', file), 'utf8')
    expect(src).toContain('// Dynamic on purpose: the brand lives in the database (Settings > Branding), so this metadata route must render per request, never at build time.')
    expect(src).toMatch(/await connection\(\)/)
    expect(src).toMatch(/await getBrand\(\)/)
  })
})

describe('proxy matcher', () => {
  it('leaves the icon, apple-icon and manifest routes ungated', async () => {
    vi.stubEnv('SESSION_SECRET', 'unit-test-only-secret-not-a-real-value-0123456789')
    const { config } = await import('@/proxy')
    const re = new RegExp(`^${config.matcher[0]}$`)
    for (const p of ['/icon/32', '/icon/svg', '/apple-icon', '/manifest.webmanifest']) expect(re.test(p), p).toBe(false)
    expect(re.test('/patients')).toBe(true)
  })
})
