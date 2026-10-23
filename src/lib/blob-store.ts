// SERVER ONLY. The private file store for uploaded and generated files (documents, insurance cards,
// imaging, lab report PDFs, claim copies). A blob URL never reaches a client or a log line: bytes are
// streamed only by authenticated, audited routes, and errors are logged by class name only.
//
// Docker-only deployment: the local-disk driver (src/lib/blob-local.ts) is the only driver. It writes
// under BLOB_LOCAL_DIR (default ./data/blobs; /app/data/blobs, the `hims_blobs` volume, in the
// container). BLOB_DRIVER may be unset or "local"; any other value means "no driver", and every read
// and write throws ServiceNotConfiguredError('blob') so the route answers 503 with one [config] log
// line (src/lib/service-config.ts) instead of a 500. Another driver can be added behind BlobDriver.
import { NextResponse } from 'next/server'
import { ServiceNotConfiguredError } from '@/lib/service-config'
import { createLocalBlobDriver, type BlobDriver } from '@/lib/blob-local'

export type { BlobDriver }

export const DEFAULT_BLOB_LOCAL_DIR = './data/blobs'

/** The active driver: the local-disk driver unless BLOB_DRIVER names one that does not exist (then null). */
export function getBlobDriver(env: Record<string, string | undefined> = process.env): BlobDriver | null {
  const driver = (env.BLOB_DRIVER ?? '').trim()
  if (driver !== '' && driver !== 'local') return null
  return createLocalBlobDriver((env.BLOB_LOCAL_DIR ?? '').trim() || DEFAULT_BLOB_LOCAL_DIR)
}

/** A path segment safe for any driver: ASCII letters, digits, `.`, `-`, `_` (others become `_`). */
export function safeBlobSegment(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
  return cleaned === '' ? 'file' : cleaned.slice(0, 120)
}

function requireDriver(): BlobDriver {
  const d = getBlobDriver()
  if (!d) throw new ServiceNotConfiguredError('blob')
  return d
}

export async function putPrivateBlob(path: string, body: Uint8Array, contentType: string): Promise<{ url: string }> {
  return requireDriver().put(path, body, contentType)
}

/**
 * The stored bytes and content type, or null when the blob cannot be read (missing, not a URL of
 * this store, any store error; logged by error class only). Throws ServiceNotConfiguredError when
 * there is no store at all.
 */
export async function readPrivateBlob(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  return requireDriver().get(url).catch((err) => {
    console.warn(`[blob-store] read failed (${err instanceof Error ? err.name : 'UnknownError'})`)
    return null
  })
}

/** Best-effort removal; never throws (a failed delete only leaves an orphaned file). */
export async function deletePrivateBlob(url: string): Promise<void> {
  try {
    await getBlobDriver()?.delete(url)
  } catch (err) {
    console.warn(`[blob-store] delete failed (${err instanceof Error ? err.name : 'UnknownError'})`)
  }
}

/** True when a driver exists and can write now (GET /api/health). */
export async function isBlobStoreWritable(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const d = getBlobDriver(env)
  return d ? d.writable() : false
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
  const found = await readPrivateBlob(url)
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
