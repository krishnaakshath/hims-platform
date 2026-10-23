// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  deletePrivateBlob, getBlobDriver, isBlobStoreWritable, putPrivateBlob, readPrivateBlob, safeBlobSegment, streamPrivateBlob,
} from '@/lib/blob-store'
import { ServiceNotConfiguredError } from '@/lib/service-config'

// The local-disk driver is the only file store (Docker-only deployment).
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'hims-blobstore-'))
  vi.stubEnv('BLOB_DRIVER', '')
  vi.stubEnv('BLOB_LOCAL_DIR', dir)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('blob-store', () => {
  it('round-trips through the local driver and never logs the URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { url } = await putPrivateBlob('lab-reports/1/x.pdf', new Uint8Array([37, 80, 68, 70]), 'application/pdf')
    expect(url).toBe('local:lab-reports/1/x.pdf')
    const got = await readPrivateBlob(url)
    expect(Array.from(got!.bytes)).toEqual([37, 80, 68, 70])
    expect(got!.contentType).toBe('application/pdf')
    expect(warn).not.toHaveBeenCalled()
  })

  it('streams a found blob with the content type, disposition and no-store caching', async () => {
    const { url } = await putPrivateBlob('lab-reports/1/y.pdf', new TextEncoder().encode('%PDF-'), 'application/pdf')
    const res = await streamPrivateBlob(url, { filename: 'LR-2099-000001.pdf', disposition: 'attachment' })
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('application/pdf')
    expect(res?.headers.get('content-disposition')).toBe('attachment; filename="LR-2099-000001.pdf"')
    expect(res?.headers.get('cache-control')).toBe('private, no-store')
    expect(await res?.text()).toBe('%PDF-')
  })

  it('strips quotes and path characters from the filename', async () => {
    const { url } = await putPrivateBlob('k/z', new Uint8Array([1]), 'application/pdf')
    const res = await streamPrivateBlob(url, { filename: 'a"b/../c.pdf', disposition: 'inline' })
    expect(res?.headers.get('content-disposition')).toBe('inline; filename="a_b_.._c.pdf"')
  })

  it('returns null for a missing or foreign URL', async () => {
    expect(await streamPrivateBlob('local:nope/a.pdf', { filename: 'a.pdf', disposition: 'inline' })).toBeNull()
    expect(await readPrivateBlob('https://store.example/secret/a.pdf')).toBeNull()
  })

  it('deletes a stored blob; deleting a foreign or missing URL is a no-op', async () => {
    const { url } = await putPrivateBlob('documents/d.pdf', new Uint8Array([1]), 'application/pdf')
    await deletePrivateBlob(url)
    expect(await readPrivateBlob(url)).toBeNull()
    await expect(deletePrivateBlob(url)).resolves.toBeUndefined()
    await expect(deletePrivateBlob('https://store.example/x')).resolves.toBeUndefined()
  })

  it('throws ServiceNotConfiguredError(blob) when BLOB_DRIVER names an unknown driver', async () => {
    vi.stubEnv('BLOB_DRIVER', 'vercel')
    expect(getBlobDriver()).toBeNull()
    await expect(putPrivateBlob('x.pdf', new Uint8Array([1]), 'application/pdf')).rejects.toMatchObject({ name: 'ServiceNotConfiguredError', service: 'blob' })
    await expect(streamPrivateBlob('local:x.pdf', { filename: 'a.pdf', disposition: 'inline' })).rejects.toBeInstanceOf(ServiceNotConfiguredError)
    await expect(deletePrivateBlob('local:x.pdf')).resolves.toBeUndefined()
  })

  it('is writable for a usable directory, not for an unusable one or an unknown driver', async () => {
    expect(await isBlobStoreWritable()).toBe(true)
    await writeFile(path.join(dir, 'file'), 'x')
    expect(await isBlobStoreWritable({ BLOB_LOCAL_DIR: path.join(dir, 'file', 'sub') })).toBe(false)
    expect(await isBlobStoreWritable({ BLOB_DRIVER: 'vercel', BLOB_LOCAL_DIR: dir })).toBe(false)
  })

  it('safeBlobSegment keeps names usable as a key', () => {
    expect(safeBlobSegment('My Scan (1).pdf')).toBe('My_Scan__1_.pdf')
    expect(safeBlobSegment('../../etc')).toBe('__.._etc')
    expect(safeBlobSegment('')).toBe('file')
  })
})
