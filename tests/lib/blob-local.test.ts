// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readdir, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createLocalBlobDriver } from '@/lib/blob-local'
import { getBlobDriver, putPrivateBlob } from '@/lib/blob-store'
import { ServiceNotConfiguredError } from '@/lib/service-config'

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'hims-blob-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.unstubAllEnvs() })

describe('local blob driver', () => {
  it('round-trips bytes and content type with an opaque url', async () => {
    const d = createLocalBlobDriver(dir)
    const { url } = await d.put('lab-reports/1/a.pdf', new Uint8Array([1, 2, 3]), 'application/pdf')
    expect(url).toBe('local:lab-reports/1/a.pdf')
    expect(url).not.toContain(dir)
    const got = await d.get(url)
    expect(Array.from(got!.bytes)).toEqual([1, 2, 3])
    expect(got!.contentType).toBe('application/pdf')
  })
  it('stores under hashed names inside the root', async () => {
    const d = createLocalBlobDriver(dir)
    await d.put('x/secret-name.pdf', new Uint8Array([1]), 'application/pdf')
    const all = (await readdir(dir, { recursive: true })).join('\n')
    expect(all).not.toContain('secret-name')
  })
  it.each(['../x', 'a/../b', '/abs', 'a\\b', 'a\0b', '', 'a//b', './a'])('rejects %j', async (p) => {
    await expect(createLocalBlobDriver(dir).put(p, new Uint8Array([1]), 'text/plain')).rejects.toThrow()
  })
  it.each(['../x', 'a/../b', '/abs', 'a\\b', 'a\0b'])('creates nothing in the root or its parent after rejecting %j', async (p) => {
    const root = path.join(dir, 'root')
    await mkdir(root)
    const before = [await readdir(root, { recursive: true }), await readdir(dir, { recursive: true })]
    await expect(createLocalBlobDriver(root).put(p, new Uint8Array([1]), 'text/plain')).rejects.toThrow()
    expect([await readdir(root, { recursive: true }), await readdir(dir, { recursive: true })]).toEqual(before)
  })
  it('write failures carry no path and no key', async () => {
    const blocker = path.join(dir, 'file-not-dir')
    await writeFile(blocker, 'x')
    const key = 'very-secret-key/name.pdf'
    const err = await createLocalBlobDriver(path.join(blocker, 'sub')).put(key, new Uint8Array([1]), 'text/plain').then(() => null, (e: Error) => e)
    expect(err).not.toBeNull()
    expect(err!.name).toBe('LocalBlobWriteError')
    const text = `${err!.name} ${err!.message} ${err!.stack ?? ''} ${JSON.stringify(err)}`
    expect(text).not.toContain(dir)
    expect(text).not.toContain('very-secret-key')
    expect(text).not.toContain('file-not-dir')
  })
  it('overwriting a key never pairs bytes with the wrong content type', async () => {
    const d = createLocalBlobDriver(dir)
    const A = new Uint8Array([1, 1, 1]); const B = new Uint8Array([2, 2, 2, 2])
    await d.put('k/a', A, 'text/a')
    const seen = new Set<string>()
    let stop = false
    const reader = (async () => {
      while (!stop) {
        const g = await d.get('local:k/a')
        if (g) seen.add(`${g.bytes.length}:${g.contentType}`)
        await new Promise((r) => setImmediate(r))
      }
    })()
    for (let i = 0; i < 40; i++) await d.put('k/a', i % 2 ? A : B, i % 2 ? 'text/a' : 'text/b')
    stop = true
    await reader
    for (const s of seen) expect(['3:text/a', '4:text/b']).toContain(s)
  })
  it('a missing or mismatched sidecar reads as null', async () => {
    const d = createLocalBlobDriver(dir)
    await d.put('k/b', new Uint8Array([1]), 'text/a')
    const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.meta'))
    expect(files.length).toBe(1)
    await writeFile(path.join(dir, files[0]), JSON.stringify({ contentType: 'text/z', digest: 'bogus' }))
    expect(await d.get('local:k/b')).toBeNull()
    await rm(path.join(dir, files[0]))
    expect(await d.get('local:k/b')).toBeNull()
  })
  it('leaves no temp files after a successful put', async () => {
    const d = createLocalBlobDriver(dir)
    await d.put('k/c', new Uint8Array([1]), 'text/a')
    expect((await readdir(dir, { recursive: true })).filter((f) => f.includes('.tmp'))).toEqual([])
  })
  it('get of unknown or hostile urls returns null', async () => {
    const d = createLocalBlobDriver(dir)
    expect(await d.get('local:nope/x.pdf')).toBeNull()
    expect(await d.get('local:../../etc/passwd')).toBeNull()
    expect(await d.get('https://x.example/y')).toBeNull()
    expect(await d.get('/etc/passwd')).toBeNull()
  })
})

describe('getBlobDriver selection', () => {
  it('local when BLOB_DRIVER=local, even in production', () => {
    expect(getBlobDriver({ BLOB_DRIVER: 'local', NODE_ENV: 'production', BLOB_LOCAL_DIR: dir })).not.toBeNull()
  })
  it('local with no token outside production', () => {
    expect(getBlobDriver({ NODE_ENV: 'development', BLOB_LOCAL_DIR: dir })).not.toBeNull()
  })
  it('null with no token in production', () => {
    expect(getBlobDriver({ NODE_ENV: 'production' })).toBeNull()
  })
  it('vercel driver when a token exists', () => {
    expect(getBlobDriver({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x', NODE_ENV: 'production' })).not.toBeNull()
  })
  it('putPrivateBlob throws ServiceNotConfiguredError(blob) with no driver', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '')
    vi.stubEnv('BLOB_STORE_ID', '')
    vi.stubEnv('BLOB_DRIVER', '')
    await expect(putPrivateBlob('a/b.pdf', new Uint8Array([1]), 'application/pdf')).rejects.toBeInstanceOf(ServiceNotConfiguredError)
  })
})
