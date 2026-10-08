// SERVER ONLY. SP5: the private blob store for generated files (lab report PDFs). A blob URL
// never reaches a client or a log line: bytes are streamed only by authenticated, audited
// routes through streamPrivateBlob, and errors are logged by class name only (the message of a
// @vercel/blob error embeds the URL).
import { NextResponse } from 'next/server'
import { get, put } from '@vercel/blob'

export async function putPrivateBlob(path: string, body: Uint8Array, contentType: string): Promise<{ url: string }> {
  const res = await put(path, Buffer.from(body), { access: 'private', contentType, addRandomSuffix: false })
  return { url: res.url }
}

/** A quoted-string-safe filename for Content-Disposition (ASCII letters, digits, `.`, `-`, `_`). */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned === '' ? 'download' : cleaned
}

/**
 * The stored bytes as a no-store response, or null when the blob cannot be read (missing,
 * not a blob URL, any store error). The caller audits only after a non-null result.
 */
export async function streamPrivateBlob(
  url: string,
  opts: { filename: string; disposition: 'inline' | 'attachment' },
): Promise<Response | null> {
  let blob: Awaited<ReturnType<typeof get>>
  try {
    blob = await get(url, { access: 'private' })
  } catch (err) {
    console.warn(`[blob-store] read failed (${err instanceof Error ? err.name : 'UnknownError'})`)
    return null
  }
  if (!blob || blob.statusCode !== 200 || !blob.stream) return null
  return new NextResponse(blob.stream, {
    headers: {
      'Content-Type': blob.blob.contentType || 'application/octet-stream',
      'Content-Disposition': `${opts.disposition}; filename="${safeFilename(opts.filename)}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
