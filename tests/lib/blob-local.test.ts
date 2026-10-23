// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
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
