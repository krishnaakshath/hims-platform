// Public, content-addressed brand asset route (WL T5, lane ruling R4). The login page needs the
// logo before sign-in, so there is no session check: only the CURRENT asset's sha256-prefix URL
// resolves (a replaced or reset asset 404s), everything else is 404 no-store. The stored blob URL
// and path never appear in a response, header or log line. The lookup uses the cached brand
// snapshot, which invalidateBrandCache() refreshes after every branding write.
import { getBrandAssetRow } from '@/lib/brand-server'
import type { BrandAssetKind } from '@/lib/brand-snapshot'
import { getPrivateBlobBytes } from '@/lib/blob-store'

const FILE_RE = /^(logo-light|logo-dark|icon-32|icon-180|icon-192|icon-512)-([0-9a-f]{16})\.png$/

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await ctx.params
  const m = FILE_RE.exec(file)
  if (!m) return notFound()
  const row = await getBrandAssetRow(m[1].replace('-', '_') as BrandAssetKind)
  if (!row || row.sha256.slice(0, 16) !== m[2]) return notFound()
  const bytes = await getPrivateBlobBytes(row.blobUrl)
  if (!bytes) return notFound()
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  })
}
