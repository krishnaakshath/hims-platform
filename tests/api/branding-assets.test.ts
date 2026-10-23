// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'
import { ALL_ROLES } from '@/lib/role-policy'

// WL T7: POST/DELETE /api/settings/branding/assets (spec §4.2, §6; lane ruling R3). The blob store is
// the real local driver in a temp dir; rows and audits go to the isolated test DB. The upload rate
// limiter is mocked except in the one test that drives the real (Redis REST) limiter to its limit.

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const ACTOR = `TEST-WL7-${RUN}`
let role: Role = 'admin'

const { revalidateTag, rateLimit, readCappedSpy } = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
  rateLimit: vi.fn<(staff: string) => Promise<{ allowed: boolean }>>(async () => ({ allowed: true })),
  readCappedSpy: vi.fn(),
}))
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => Promise<unknown>) => fn, revalidateTag }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role, name: ACTOR, userId: null })) }
})
vi.mock('@/lib/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rate-limit')>('@/lib/rate-limit')
  return { ...actual, checkBrandUploadRateLimit: rateLimit }
})
vi.mock('@/lib/http/read-capped-body', async () => {
  const actual = await vi.importActual<typeof import('@/lib/http/read-capped-body')>('@/lib/http/read-capped-body')
  readCappedSpy.mockImplementation(actual.readCappedBody)
  return { ...actual, readCappedBody: readCappedSpy }
})

import { POST, DELETE } from '@/app/api/settings/branding/assets/route'
import { GET as getAsset } from '@/app/branding/[file]/route'
import { getDb } from '@/db/client'
import { auditLog, brandAssets } from '@/db/schema'
import { asc, eq } from 'drizzle-orm'
import { resetBrandSettings } from '@/lib/queries/brand-settings'

const ENDPOINT = 'http://localhost/api/settings/branding/assets'
let dir: string
const bodies: string[] = []

async function png(w: number, h: number): Promise<Uint8Array> {
  const buf = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 25, g: 79, b: 129, alpha: 1 } } }).png().toBuffer()
  return new Uint8Array(buf)
}
async function jpeg(w: number, h: number): Promise<Uint8Array> {
  const buf = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 10, b: 10 } } }).jpeg().toBuffer()
  return new Uint8Array(buf)
}

function upload(fields: { variant?: string; file?: { bytes: Uint8Array; type: string; name?: string } } & Record<string, unknown>, headers: Record<string, string> = {}) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'file' && v) {
      const f = v as { bytes: Uint8Array; type: string; name?: string }
      form.append('file', new File([Buffer.from(f.bytes)], f.name ?? 'acme-logo.png', { type: f.type }))
    } else if (v !== undefined) {
      form.append(k, String(v))
    }
  }
  return new NextRequest(ENDPOINT, { method: 'POST', body: form, headers })
}
const remove = (query: string, headers: Record<string, string> = {}) => new NextRequest(`${ENDPOINT}${query}`, { method: 'DELETE', headers })

async function json(res: Response) {
  const text = await res.text()
  bodies.push(text)
  return JSON.parse(text)
}

const rows = async () =>
  getDb().select({ kind: brandAssets.kind, source: brandAssets.source, sha256: brandAssets.sha256, width: brandAssets.width, height: brandAssets.height })
    .from(brandAssets).orderBy(asc(brandAssets.kind))
const auditRows = async () =>
  getDb().select({ action: auditLog.action, details: auditLog.details }).from(auditLog).where(eq(auditLog.userName, ACTOR)).orderBy(asc(auditLog.id))

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'brand-assets-'))
  vi.stubEnv('BLOB_DRIVER', 'local')
  vi.stubEnv('BLOB_LOCAL_DIR', dir)
})
afterEach(async () => {
  role = 'admin'
  revalidateTag.mockReset()
  rateLimit.mockReset()
  rateLimit.mockImplementation(async () => ({ allowed: true }))
  readCappedSpy.mockClear()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
  await resetBrandSettings(null)
})
afterAll(async () => {
  await getDb().delete(auditLog).where(eq(auditLog.userName, ACTOR))
  // No response body ever carries a blob URL, a key or the uploaded file name.
  for (const b of bodies) {
    expect(b).not.toContain('local:')
    expect(b).not.toContain('acme-logo')
    expect(b).not.toMatch(/branding\/(logo|icon)_/) // the blob key shape (kind with an underscore)
    expect(b).not.toContain(dir)
  }
})

describe('gates', () => {
  it.each(ALL_ROLES.filter((r) => r !== 'admin'))('%s gets 403 on POST and DELETE before the body is read', async (r) => {
    role = r
    const big = new NextRequest(ENDPOINT, { method: 'POST', body: new Uint8Array(3_000_000), headers: { 'content-type': 'multipart/form-data; boundary=x' } })
    for (const res of [await POST(big), await DELETE(remove('?variant=light'))]) {
      expect(res.status).toBe(403)
      expect(await json(res)).toEqual({ error: 'Forbidden' })
    }
    expect(readCappedSpy).not.toHaveBeenCalled()
    expect(rateLimit).not.toHaveBeenCalled()
  })

  it('rejects a cross-origin POST and DELETE', async () => {
    const res = await POST(upload({ variant: 'light', file: { bytes: await png(400, 100), type: 'image/png' } }, { origin: 'https://evil.example' }))
    expect(res.status).toBe(403)
    expect(await json(res)).toEqual({ error: 'Cross-origin request rejected' })
    const del = await DELETE(remove('?variant=light', { origin: 'https://evil.example' }))
    expect(del.status).toBe(403)
    expect(readCappedSpy).not.toHaveBeenCalled()
  })

  it('413s a declared content-length over 1.5 MB without reading the body', async () => {
    const req = new NextRequest(ENDPOINT, {
      method: 'POST', body: new Uint8Array(10), headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '1572865' },
    })
    const res = await POST(req)
    expect(res.status).toBe(413)
    expect(await json(res)).toEqual({ error: 'Image must be 1 MB or smaller', code: 'too_large' })
    expect(readCappedSpy).not.toHaveBeenCalled()
    expect(rateLimit).not.toHaveBeenCalled()
  })
})

describe('POST validation', () => {
  it('400s with no file, an unknown variant or an extra field', async () => {
    let res = await POST(upload({ variant: 'light' }))
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ error: 'Choose an image file' })
    for (const fields of [
      { variant: 'banner', file: { bytes: await png(400, 100), type: 'image/png' } },
      { file: { bytes: await png(400, 100), type: 'image/png' } },
      { variant: 'light', extra: 'x', file: { bytes: await png(400, 100), type: 'image/png' } },
    ]) {
      res = await POST(upload(fields))
      expect(res.status).toBe(400)
      expect(await json(res)).toEqual({ error: 'Invalid upload' })
    }
    expect(await rows()).toEqual([])
  })

  it('413s a file over 1 MB and an SVG over 256 KB', async () => {
    let res = await POST(upload({ variant: 'light', file: { bytes: new Uint8Array(1_048_577), type: 'image/png' } }))
    expect(res.status).toBe(413)
    expect((await json(res)).code).toBe('too_large')
    res = await POST(upload({ variant: 'light', file: { bytes: new Uint8Array(262_145), type: 'image/svg+xml', name: 'acme-logo.svg' } }))
    expect(res.status).toBe(413)
    expect((await json(res)).code).toBe('too_large')
  })

  it('415s a JPEG declared as PNG', async () => {
    const res = await POST(upload({ variant: 'light', file: { bytes: await jpeg(400, 100), type: 'image/png' } }))
    expect(res.status).toBe(415)
    expect(await json(res)).toEqual({ error: 'Use a PNG, JPEG, WebP or SVG image', code: 'type_mismatch' })
  })

  it('422s an unsafe SVG and stores nothing', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><script>alert(1)</script></svg>'
    const res = await POST(upload({ variant: 'light', file: { bytes: new TextEncoder().encode(svg), type: 'image/svg+xml', name: 'acme-logo.svg' } }))
    expect(res.status).toBe(422)
    expect((await json(res)).code).toBe('svg_unsafe')
    expect(await rows()).toEqual([])
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('503s storage_not_configured when there is no blob driver', async () => {
    vi.stubEnv('BLOB_DRIVER', 's3')
    const res = await POST(upload({ variant: 'light', file: { bytes: await png(400, 100), type: 'image/png' } }))
    expect(res.status).toBe(503)
    expect(await json(res)).toEqual({ error: 'File storage is not set up. Ask your administrator.', code: 'storage_not_configured' })
    expect(await rows()).toEqual([])
  })
})

describe('uploads and removal', () => {
  it('stores a light logo with derived icons, audits once, invalidates and serves it', async () => {
    const before = (await auditRows()).length
    const res = await POST(upload({ variant: 'light', file: { bytes: await png(400, 100), type: 'image/png' } }))
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body.ok).toBe(true)
    expect(body.asset).toEqual({ kind: 'logo_light', path: expect.stringMatching(/^\/branding\/logo-light-[0-9a-f]{16}\.png$/), width: 400, height: 100 })
    expect(Object.keys(body.asset).sort()).toEqual(['height', 'kind', 'path', 'width'])
    expect(rateLimit).toHaveBeenCalledWith(ACTOR)

    const stored = await rows()
    expect(stored.map((r) => [r.kind, r.source])).toEqual([
      ['icon_180', 'derived'], ['icon_192', 'derived'], ['icon_32', 'derived'], ['icon_512', 'derived'], ['logo_light', 'upload'],
    ])
    const audits = (await auditRows()).slice(before)
    expect(audits).toHaveLength(1)
    expect(audits[0].action).toBe('branding: uploaded asset')
    expect(audits[0].details).toMatch(/^variant=light bytes=\d+ w=400 h=100$/)
    expect(revalidateTag).toHaveBeenCalledTimes(1)

    const file = body.asset.path.slice('/branding/'.length)
    const served = await getAsset(new Request(`http://localhost${body.asset.path}`) as never, { params: Promise.resolve({ file }) } as never)
    expect(served.status).toBe(200)
    const meta = await sharp(Buffer.from(await served.arrayBuffer())).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 400, 100])
  })

  it('an icon upload makes the icons source=upload; a later light upload keeps them; deleting the icon re-derives', async () => {
    await POST(upload({ variant: 'light', file: { bytes: await png(400, 100), type: 'image/png' } }))
    const derived = Object.fromEntries((await rows()).map((r) => [r.kind, r.sha256]))

    const res = await POST(upload({ variant: 'icon', file: { bytes: await png(256, 256), type: 'image/png', name: 'acme-icon.png' } }))
    expect(res.status).toBe(201)
    expect((await json(res)).asset).toEqual({ kind: 'icon_512', path: expect.stringMatching(/^\/branding\/icon-512-[0-9a-f]{16}\.png$/), width: 512, height: 512 })
    const afterIcon = await rows()
    expect(afterIcon.filter((r) => r.kind.startsWith('icon_')).map((r) => [r.kind, r.source, r.width])).toEqual([
      ['icon_180', 'upload', 180], ['icon_192', 'upload', 192], ['icon_32', 'upload', 32], ['icon_512', 'upload', 512],
    ])

    await POST(upload({ variant: 'light', file: { bytes: await png(800, 200), type: 'image/png' } }))
    expect((await rows()).filter((r) => r.kind.startsWith('icon_')).every((r) => r.source === 'upload')).toBe(true)

    const before = (await auditRows()).length
    const del = await DELETE(remove('?variant=icon'))
    expect(del.status).toBe(200)
    expect(await json(del)).toEqual({ ok: true })
    const after = await rows()
    expect(after.filter((r) => r.kind.startsWith('icon_')).map((r) => [r.kind, r.source])).toEqual([
      ['icon_180', 'derived'], ['icon_192', 'derived'], ['icon_32', 'derived'], ['icon_512', 'derived'],
    ])
    expect(after.find((r) => r.kind === 'icon_32')!.sha256).not.toBe(afterIcon.find((r) => r.kind === 'icon_32')!.sha256)
    expect(derived.icon_32).toBeDefined()
    expect((await auditRows()).slice(before)).toEqual([{ action: 'branding: removed asset', details: 'variant=icon' }])
    expect(revalidateTag).toHaveBeenCalled()
  })

  it('deleting light removes the logo and the derived icons but keeps uploaded icons', async () => {
    await POST(upload({ variant: 'light', file: { bytes: await png(400, 100), type: 'image/png' } }))
    await POST(upload({ variant: 'dark', file: { bytes: await png(400, 100), type: 'image/png' } }))
    let res = await DELETE(remove('?variant=light'))
    expect(res.status).toBe(200)
    expect((await rows()).map((r) => r.kind)).toEqual(['logo_dark'])

    await POST(upload({ variant: 'icon', file: { bytes: await png(256, 256), type: 'image/png' } }))
    await POST(upload({ variant: 'light', file: { bytes: await png(400, 100), type: 'image/png' } }))
    res = await DELETE(remove('?variant=light'))
    expect(res.status).toBe(200)
    expect((await rows()).map((r) => [r.kind, r.source])).toEqual([
      ['icon_180', 'upload'], ['icon_192', 'upload'], ['icon_32', 'upload'], ['icon_512', 'upload'], ['logo_dark', 'upload'],
    ])
    res = await DELETE(remove('?variant=dark'))
    expect(res.status).toBe(200)
    expect((await rows()).map((r) => r.kind)).not.toContain('logo_dark')
  })

  it('deleting the icon with no light logo leaves no icons', async () => {
    await POST(upload({ variant: 'icon', file: { bytes: await png(256, 256), type: 'image/png' } }))
    const res = await DELETE(remove('?variant=icon'))
    expect(res.status).toBe(200)
    expect(await rows()).toEqual([])
  })

  it('DELETE 400s an invalid, missing or repeated variant', async () => {
    for (const q of ['', '?variant=banner', '?variant=light&variant=dark', '?variant=light&x=1']) {
      const res = await DELETE(remove(q))
      expect(res.status).toBe(400)
      expect(await json(res)).toEqual({ error: 'Invalid variant' })
    }
    expect(revalidateTag).not.toHaveBeenCalled()
  })
})

describe('rate limit', () => {
  it('the eleventh upload by one admin in 10 minutes is a 429 (real Redis REST limiter)', async () => {
    const actual = await vi.importActual<typeof import('@/lib/rate-limit')>('@/lib/rate-limit')
    await actual.__resetBrandUploadGlobalBucketForTests()
    try {
      rateLimit.mockImplementation(actual.checkBrandUploadRateLimit)
      for (let i = 0; i < 10; i++) expect(await actual.checkBrandUploadRateLimit(ACTOR)).toEqual({ allowed: true })
      const res = await POST(upload({ variant: 'light', file: { bytes: await png(400, 100), type: 'image/png' } }))
      expect(res.status).toBe(429)
      expect(await json(res)).toEqual({ error: 'Too many uploads. Try again in a few minutes.' })
      expect(readCappedSpy).not.toHaveBeenCalled()
      expect(await rows()).toEqual([])
    } finally {
      await actual.__resetBrandUploadGlobalBucketForTests()
    }
  })
})
