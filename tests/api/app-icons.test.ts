// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'

// The metadata routes read the deployment brand at module load, so each test
// stubs BRAND_* env and re-imports them, as a fresh server process would.
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
  vi.unstubAllEnvs()
  vi.resetModules()
})

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
    const res = apple.default()
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
    const m = manifest()
    expect(m.name).toBe('Saint Mary General Hospital')
    expect(m.short_name).toBe('Saint')
    expect(m.theme_color).toBe('#0b3d2e')
    expect(m.background_color).toBe('#0b3d2e')
    expect(m.icons?.map((i) => i.src)).toEqual(['/icon/192', '/icon/512', '/icon/svg', '/apple-icon'])
  })

  it('falls back to the product name and blue when the brand is unset', async () => {
    const { manifest } = await load({})
    const m = manifest()
    expect(m.name).toBe('HIMS')
    expect(m.short_name).toBe('HIMS')
    expect(m.theme_color).toBe('#194f81')
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
