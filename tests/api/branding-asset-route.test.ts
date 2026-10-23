// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// WL T5 (lane rulings R3/R4): GET /branding/[file] is public and content-addressed. The snapshot is
// mocked (cached lookup), the blob store is the real local driver in a temp dir.
const loadBrandSnapshot = vi.fn()
let dir: string

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const SHA = createHash('sha256').update(PNG).digest('hex')
const P16 = SHA.slice(0, 16)

async function setup(kind = 'logo_light') {
  const { putPrivateBlob } = await import('@/lib/blob-store')
  const { url } = await putPrivateBlob(`brand/${kind}.png`, PNG, 'image/png')
  loadBrandSnapshot.mockResolvedValue({
    settings: {}, billing: null, practice: null,
    assets: [{ kind, blobUrl: url, sha256: SHA, source: 'upload', width: 1, height: 1, byteSize: PNG.length, createdAt: '2026-10-23T00:00:00.000Z' }],
  })
  return url
}

async function get(file: string) {
  const { GET } = await import('@/app/branding/[file]/route')
  return GET(new Request(`http://localhost/branding/${file}`) as never, { params: Promise.resolve({ file }) } as never)
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'brand-route-'))
  vi.stubEnv('BLOB_DRIVER', 'local')
  vi.stubEnv('BLOB_LOCAL_DIR', dir)
  loadBrandSnapshot.mockReset()
  vi.resetModules()
  vi.doMock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn, revalidateTag: vi.fn() }))
  vi.doMock('@/lib/queries/brand-settings', () => ({ loadBrandSnapshot }))
})
afterEach(() => {
  vi.doUnmock('next/cache')
  vi.doUnmock('@/lib/queries/brand-settings')
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
  vi.resetModules()
})

describe('GET /branding/[file]', () => {
  it('serves the exact bytes with immutable headers when the hash prefix matches (no session)', async () => {
    const url = await setup()
    const res = await get(`logo-light-${P16}.png`)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(JSON.stringify([...res.headers])).not.toContain(url)
  })

  it.each(['logo-dark', 'icon-32', 'icon-180', 'icon-192', 'icon-512'])('serves %s', async (name) => {
    await setup(name.replace('-', '_'))
    expect((await get(`${name}-${P16}.png`)).status).toBe(200)
  })

  it('404s no-store on a wrong hash or when no asset of that kind exists', async () => {
    await setup()
    for (const f of [`logo-light-${'0'.repeat(16)}.png`, `logo-dark-${P16}.png`]) {
      const res = await get(f)
      expect(res.status).toBe(404)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.text()).toBe('Not found')
    }
  })

  it.each([
    `logo-light-${P16}.svg`, '../x', `logo-light-${P16.toUpperCase()}.png`, `logo-banner-${P16}.png`,
    'icon-default-194f81-32.png', `logo-light-${P16}.png/`, `x/logo-light-${P16}.png`,
  ])('404s %s without touching the store', async (f) => {
    await setup()
    const res = await get(f)
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(loadBrandSnapshot).not.toHaveBeenCalled()
  })

  it('404s and logs no URL when the blob read returns null', async () => {
    const url = await setup()
    rmSync(dir, { recursive: true, force: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await get(`logo-light-${P16}.png`)
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(JSON.stringify(warn.mock.calls)).not.toContain(url)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(dir)
  })
})
