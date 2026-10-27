// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import sharp from 'sharp'
import { processBrandImage, deriveIcons, BRAND_UPLOAD_LIMITS } from '@/lib/brand-image'

// Wrap the real sharp in a spy so a test can prove an unsafe SVG never reaches it.
vi.mock('sharp', async (importOriginal) => {
  const mod = (await importOriginal()) as { default: (...args: unknown[]) => unknown }
  const real = mod.default
  return { default: vi.fn((...args: unknown[]) => real(...args)) }
})

const sharpSpy = vi.mocked(sharp)

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

async function solidPng(width: number, height: number): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 4, background: { r: 25, g: 79, b: 129, alpha: 1 } } })
    .png()
    .toBuffer()
}

async function solidJpeg(width: number, height: number): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 3, background: { r: 25, g: 79, b: 129 } } })
    .jpeg()
    .toBuffer()
}

/** Names of the PNG chunks in order. */
function pngChunks(png: Uint8Array): string[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const names: string[] = []
  let off = 8
  while (off + 8 <= png.length) {
    const len = view.getUint32(off)
    names.push(String.fromCharCode(...png.subarray(off + 4, off + 8)))
    off += 12 + len
  }
  return names
}

const enc = (s: string) => new TextEncoder().encode(s)

describe('BRAND_UPLOAD_LIMITS', () => {
  it('has the agreed values', () => {
    expect(BRAND_UPLOAD_LIMITS).toEqual({
      maxBytes: 1_048_576,
      maxSvgBytes: 262_144,
      maxBodyBytes: 1_572_864,
      maxInputPixels: 16_777_216,
      maxDim: 4096,
      logoMin: { w: 64, h: 16 },
      iconMin: 128,
      logoBox: { w: 1024, h: 256 },
    })
  })
})

describe('processBrandImage', () => {
  beforeEach(() => sharpSpy.mockClear())

  it('re-encodes a 200x50 PNG logo to a metadata-free PNG', async () => {
    const input = await sharp({ create: { width: 200, height: 50, channels: 4, background: '#194f81' } })
      .png()
      .withExif({ IFD0: { Copyright: 'Sanjeevani Hospital' } })
      .toBuffer()
    const r = await processBrandImage(input, 'image/png', 'light')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect([...r.png.subarray(0, 8)]).toEqual(PNG_MAGIC)
    expect(r.width).toBe(200)
    expect(r.height).toBe(50)
    const chunks = pngChunks(r.png)
    expect(chunks).not.toContain('eXIf')
    expect(chunks).not.toContain('tEXt')
    expect(chunks).not.toContain('iTXt')
    expect(chunks).not.toContain('zTXt')
  })

  it('accepts a declared type with parameters and mixed case', async () => {
    const r = await processBrandImage(await solidPng(200, 50), 'Image/PNG; charset=binary', 'dark')
    expect(r.ok).toBe(true)
  })

  it('re-encodes a JPEG and a WebP to PNG', async () => {
    const jpeg = await processBrandImage(await solidJpeg(300, 100), 'image/jpeg', 'light')
    expect(jpeg.ok && [...jpeg.png.subarray(0, 8)]).toEqual(PNG_MAGIC)
    const webpBytes = await sharp({ create: { width: 300, height: 100, channels: 3, background: '#194f81' } })
      .webp()
      .toBuffer()
    const webp = await processBrandImage(webpBytes, 'image/webp', 'light')
    expect(webp.ok && [...webp.png.subarray(0, 8)]).toEqual(PNG_MAGIC)
  })

  it('fits a large logo inside 1024x256', async () => {
    const r = await processBrandImage(await solidPng(2048, 256), 'image/png', 'light')
    expect(r).toMatchObject({ ok: true, width: 1024, height: 128 })
  })

  it('rejects a JPEG declared as image/png with 415 type_mismatch', async () => {
    const r = await processBrandImage(await solidJpeg(200, 50), 'image/png', 'light')
    expect(r).toEqual({ ok: false, status: 415, code: 'type_mismatch' })
  })

  it('rejects image/gif with 415 type_not_allowed', async () => {
    const r = await processBrandImage(enc('GIF89a....'), 'image/gif', 'light')
    expect(r).toEqual({ ok: false, status: 415, code: 'type_not_allowed' })
  })

  it('rejects a 40x10 PNG with 422 image_too_small', async () => {
    const r = await processBrandImage(await solidPng(40, 10), 'image/png', 'light')
    expect(r).toEqual({ ok: false, status: 422, code: 'image_too_small' })
  })

  it('rejects an unsafe SVG with 422 svg_unsafe without ever calling sharp', async () => {
    const bad = enc('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50" onload="x"><path d="M0 0"/></svg>')
    sharpSpy.mockClear()
    const r = await processBrandImage(bad, 'image/svg+xml', 'light')
    expect(r).toEqual({ ok: false, status: 422, code: 'svg_unsafe' })
    expect(sharpSpy).not.toHaveBeenCalled()
  })

  it('rejects an SVG that is not valid UTF-8 as svg_unsafe without calling sharp', async () => {
    const head = enc('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50"><text>')
    const bytes = new Uint8Array([...head, 0xc3, 0x28, ...enc('</text></svg>')])
    sharpSpy.mockClear()
    const r = await processBrandImage(bytes, 'image/svg+xml', 'light')
    expect(r).toEqual({ ok: false, status: 422, code: 'svg_unsafe' })
    expect(sharpSpy).not.toHaveBeenCalled()
  })

  it('rasterises a safe SVG to a PNG at most 1024x256', async () => {
    const safe = enc(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50"><rect width="200" height="50" fill="#194f81"/></svg>',
    )
    const r = await processBrandImage(safe, 'image/svg+xml', 'light')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect([...r.png.subarray(0, 8)]).toEqual(PNG_MAGIC)
    expect(r.width).toBeLessThanOrEqual(1024)
    expect(r.height).toBeLessThanOrEqual(256)
    expect(r.width).toBe(1024)
    const meta = await sharp(r.png).metadata()
    expect(meta.format).toBe('png')
    expect([meta.width, meta.height]).toEqual([r.width, r.height])
  })

  it('rejects an icon at 300x100 with 422 icon_not_square', async () => {
    const r = await processBrandImage(await solidPng(300, 100), 'image/png', 'icon')
    expect(r).toEqual({ ok: false, status: 422, code: 'icon_not_square' })
  })

  it('rejects an icon below 128x128 with image_too_small and accepts a 200x180 icon', async () => {
    expect(await processBrandImage(await solidPng(100, 100), 'image/png', 'icon')).toEqual({
      ok: false,
      status: 422,
      code: 'image_too_small',
    })
    expect(await processBrandImage(await solidPng(200, 180), 'image/png', 'icon')).toMatchObject({ ok: true })
  })

  it('rejects a 5000x10 PNG with 422 image_too_large', async () => {
    const r = await processBrandImage(await solidPng(5000, 10), 'image/png', 'light')
    expect(r).toEqual({ ok: false, status: 422, code: 'image_too_large' })
  })

  it('rejects input over maxBytes with 422 image_too_large', async () => {
    const big = new Uint8Array(BRAND_UPLOAD_LIMITS.maxBytes + 1)
    big.set(PNG_MAGIC)
    const r = await processBrandImage(big, 'image/png', 'light')
    expect(r).toEqual({ ok: false, status: 422, code: 'image_too_large' })
  })

  it('rejects truncated PNG bytes with 422 image_undecodable', async () => {
    const full = await sharp({
      create: { width: 400, height: 100, channels: 3, background: '#000000', noise: { type: 'gaussian', mean: 128, sigma: 30 } },
    })
      .png()
      .toBuffer()
    const r = await processBrandImage(full.subarray(0, Math.floor(full.length / 2)), 'image/png', 'light')
    expect(r).toEqual({ ok: false, status: 422, code: 'image_undecodable' })
  })
})

describe('deriveIcons', () => {
  it('returns square transparent-padded PNGs at 32, 180, 192 and 512', async () => {
    const icons = await deriveIcons(await solidPng(200, 160))
    expect(icons.map((i) => i.size)).toEqual([32, 180, 192, 512])
    for (const icon of icons) {
      expect([...icon.png.subarray(0, 8)]).toEqual(PNG_MAGIC)
      const meta = await sharp(icon.png).metadata()
      expect([meta.width, meta.height]).toEqual([icon.size, icon.size])
      expect(meta.hasAlpha).toBe(true)
    }
    // 200x160 contained in a square leaves transparent bands top and bottom.
    const { data, info } = await sharp(icons[3].png).raw().toBuffer({ resolveWithObject: true })
    expect(info.channels).toBe(4)
    expect(data[3]).toBe(0) // top-left pixel alpha
    const mid = (256 * 512 + 256) * 4
    expect(data[mid + 3]).toBe(255)
  })
})
