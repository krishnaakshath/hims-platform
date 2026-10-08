// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const put = vi.fn()
const get = vi.fn()
vi.mock('@vercel/blob', () => ({ put: (...a: unknown[]) => put(...a), get: (...a: unknown[]) => get(...a) }))

import { putPrivateBlob, streamPrivateBlob } from '@/lib/blob-store'
import { ServiceNotConfiguredError } from '@/lib/service-config'

// blob-store refuses to reach the (mocked) blob SDK without a configured store.
beforeEach(() => { vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_test_token') })

const URL = 'https://store.private.blob.vercel-storage.com/lab-reports/1/LR-2099-000001-x.pdf'

describe('blob-store', () => {
  let warn: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    put.mockReset(); get.mockReset()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => { warn.mockRestore(); error.mockRestore() })

  const logged = () => [...warn.mock.calls, ...error.mock.calls].flat().map(String).join('\n')

  it('puts with private access and never logs the URL', async () => {
    put.mockResolvedValue({ url: URL })
    const bytes = new Uint8Array([37, 80, 68, 70])
    expect(await putPrivateBlob('lab-reports/1/x.pdf', bytes, 'application/pdf')).toEqual({ url: URL })
    expect(put).toHaveBeenCalledWith('lab-reports/1/x.pdf', expect.any(Buffer), { access: 'private', contentType: 'application/pdf', addRandomSuffix: false })
    expect([...(put.mock.calls[0][1] as Buffer)]).toEqual([37, 80, 68, 70])
    expect(logged()).not.toContain(URL)
  })

  it('streams a found blob with the content type, disposition and no-store caching', async () => {
    get.mockResolvedValue({ statusCode: 200, stream: new Blob(['%PDF-']).stream(), blob: { contentType: 'application/pdf' } })
    const res = await streamPrivateBlob(URL, { filename: 'LR-2099-000001.pdf', disposition: 'attachment' })
    expect(get).toHaveBeenCalledWith(URL, { access: 'private' })
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('application/pdf')
    expect(res?.headers.get('content-disposition')).toBe('attachment; filename="LR-2099-000001.pdf"')
    expect(res?.headers.get('cache-control')).toBe('private, no-store')
    expect(await res?.text()).toBe('%PDF-')
  })

  it('strips quotes and path characters from the filename', async () => {
    get.mockResolvedValue({ statusCode: 200, stream: new Blob(['x']).stream(), blob: { contentType: 'application/pdf' } })
    const res = await streamPrivateBlob(URL, { filename: 'a"b/../c.pdf', disposition: 'inline' })
    expect(res?.headers.get('content-disposition')).toBe('inline; filename="a_b_.._c.pdf"')
  })

  it('returns null for a missing blob, a non-200 or a thrown error, logging only the error name', async () => {
    get.mockResolvedValueOnce(null)
    expect(await streamPrivateBlob(URL, { filename: 'a.pdf', disposition: 'inline' })).toBeNull()
    get.mockResolvedValueOnce({ statusCode: 304, stream: null, blob: { contentType: 'application/pdf' } })
    expect(await streamPrivateBlob(URL, { filename: 'a.pdf', disposition: 'inline' })).toBeNull()
    const err = new Error(`Blob not found: ${URL}`)
    err.name = 'BlobNotFoundError'
    get.mockRejectedValueOnce(err)
    expect(await streamPrivateBlob(URL, { filename: 'a.pdf', disposition: 'inline' })).toBeNull()
    expect(logged()).toContain('BlobNotFoundError')
    expect(logged()).not.toContain(URL)
  })

  it('throws ServiceNotConfiguredError(blob) without a store, before calling the SDK', async () => {
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '')
    vi.stubEnv('BLOB_STORE_ID', '')
    await expect(putPrivateBlob('x.pdf', new Uint8Array([1]), 'application/pdf')).rejects.toMatchObject({ name: 'ServiceNotConfiguredError', service: 'blob' })
    await expect(streamPrivateBlob(URL, { filename: 'a.pdf', disposition: 'inline' })).rejects.toBeInstanceOf(ServiceNotConfiguredError)
    expect(put).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })
})
