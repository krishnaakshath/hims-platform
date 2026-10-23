// SERVER ONLY. SP5: the private blob store for generated files (lab report PDFs). A blob URL
// never reaches a client or a log line: bytes are streamed only by authenticated, audited
// routes through streamPrivateBlob, and errors are logged by class name only (the message of a
// @vercel/blob error embeds the URL). With no store configured, putPrivateBlob and
// streamPrivateBlob throw ServiceNotConfiguredError('blob'): the route answers 503 with one
// [config] log line (src/lib/service-config.ts) instead of a 500.
import { NextResponse } from 'next/server'
import { get, put } from '@vercel/blob'
import { ServiceNotConfiguredError } from '@/lib/service-config'
import { createLocalBlobDriver, type BlobDriver } from '@/lib/blob-local'

export type { BlobDriver }

function vercelDriver(): BlobDriver {
  return {
    async put(path, body, contentType) {
      const res = await put(path, Buffer.from(body), { access: 'private', contentType, addRandomSuffix: false })
      return { url: res.url }
    },
    async get(url) {
      try {
        const blob = await get(url, { access: 'private' })
        if (!blob || blob.statusCode !== 200 || !blob.stream) return null
        const bytes = new Uint8Array(await new Response(blob.stream).arrayBuffer())
        return { bytes, contentType: blob.blob.contentType || 'application/octet-stream' }
      } catch (err) {
        console.warn(`[blob-store] read failed (${err instanceof Error ? err.name : 'UnknownError'})`)
        return null
      }
    },
  }
}

/**
 * The active driver: Vercel Blob when a token (or OIDC store id) exists; the local-disk driver
 * when BLOB_DRIVER=local, or when there is no store and this is not production; otherwise null.
 */
export function getBlobDriver(env: Record<string, string | undefined> = process.env): BlobDriver | null {
  if ((env.BLOB_READ_WRITE_TOKEN ?? '').trim() !== '' || (env.BLOB_STORE_ID ?? '').trim() !== '') return vercelDriver()
  if (env.BLOB_DRIVER === 'local' || env.NODE_ENV !== 'production') {
    return createLocalBlobDriver((env.BLOB_LOCAL_DIR ?? '').trim() || './data/blobs')
  }
  return null
}

function requireDriver(): BlobDriver {
  const d = getBlobDriver()
  if (!d) throw new ServiceNotConfiguredError('blob')
  return d
}

export async function putPrivateBlob(path: string, body: Uint8Array, contentType: string): Promise<{ url: string }> {
  return requireDriver().put(path, body, contentType)
}

/** A quoted-string-safe filename for Content-Disposition (ASCII letters, digits, `.`, `-`, `_`). */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned === '' ? 'download' : cleaned
}

/**
 * The stored bytes as a no-store response, or null when the blob cannot be read (missing,
 * not a blob URL, any store error). The caller audits only after a non-null result.
 * Throws ServiceNotConfiguredError when there is no store at all.
 */
export async function streamPrivateBlob(
  url: string,
  opts: { filename: string; disposition: 'inline' | 'attachment' },
): Promise<Response | null> {
  const found = await requireDriver().get(url).catch((err) => {
    console.warn(`[blob-store] read failed (${err instanceof Error ? err.name : 'UnknownError'})`)
    return null
  })
  if (!found) return null
  return new NextResponse(Buffer.from(found.bytes), {
    headers: {
      'Content-Type': found.contentType || 'application/octet-stream',
      'Content-Disposition': `${opts.disposition}; filename="${safeFilename(opts.filename)}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

// SP8: the bytes of a private blob (NHCX attachments), or null when it cannot be read. Server only.
export async function getPrivateBlobBytes(url: string): Promise<Uint8Array | null> {
  try {
    const found = await getBlobDriver()?.get(url)
    return found ? found.bytes : null
  } catch (err) {
    console.warn(`[blob-store] read failed (${err instanceof Error ? err.name : 'UnknownError'})`)
    return null
  }
}
