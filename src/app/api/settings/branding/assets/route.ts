import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession, type Session } from '@/lib/auth'
import { BRAND_SETTINGS_ROLES } from '@/lib/role-policy'
import { rejectCrossOrigin } from '@/lib/csrf'
import { readCappedBody } from '@/lib/http/read-capped-body'
import { serviceUnavailableBody } from '@/lib/http/service-message'
import { ServiceNotConfiguredError } from '@/lib/service-config'
import { RETRY_MESSAGE, isRetryableConflict } from '@/lib/db-errors'
import { checkBrandUploadRateLimit } from '@/lib/rate-limit'
import { deletePrivateBlob, getBlobDriver, getPrivateBlobBytes, putPrivateBlob } from '@/lib/blob-store'
import { BRAND_UPLOAD_LIMITS, deriveIcons, processBrandImage, type BrandImageErrorCode, type BrandUploadVariant } from '@/lib/brand-image'
import { brandAssetPath } from '@/lib/brand-resolve'
import { invalidateBrandCache } from '@/lib/brand-server'
import { logAudit } from '@/lib/audit'
import {
  deleteBrandAssets, inBrandAssetTx, listBrandAssetRows, putBrandAsset, type BrandAssetInput, type BrandAssetKind,
} from '@/lib/queries/brand-settings'

// WL T7: Settings > Branding logo and icon upload and removal (spec §4.2, §6; lane ruling R3).
// Admin only: the role check and the cross-origin check run before any body read (a multipart POST
// can come from a cross-site form). Every upload is re-encoded to PNG by processBrandImage; blobs are
// written first, then all rows plus ONE audit row in one transaction, then the brand cache expires.
// Responses carry hash-addressed /branding paths only; logs carry error class names only. Never a
// blob URL, key, file name or path.

const VARIANTS = ['light', 'dark', 'icon'] as const
const variantSchema = z.object({ variant: z.enum(VARIANTS) }).strict()

const ICON_KINDS = ['icon_32', 'icon_180', 'icon_192', 'icon_512'] as const satisfies readonly BrandAssetKind[]
const LOGO_KIND: Record<Exclude<BrandUploadVariant, 'icon'>, BrandAssetKind> = { light: 'logo_light', dark: 'logo_dark' }

const FORBIDDEN = { error: 'Forbidden' }
const TOO_LARGE = { error: 'Image must be 1 MB or smaller', code: 'too_large' }
const SVG_TOO_LARGE = { error: 'An SVG must be 256 KB or smaller', code: 'too_large' }
const INVALID_UPLOAD = { error: 'Invalid upload' }
const RATE_LIMITED = { error: 'Too many uploads. Try again in a few minutes.' }

function imageErrorMessage(code: BrandImageErrorCode, variant: BrandUploadVariant): string {
  switch (code) {
    case 'type_not_allowed':
    case 'type_mismatch': return 'Use a PNG, JPEG, WebP or SVG image'
    case 'svg_unsafe': return 'This SVG cannot be used. Save it as a plain SVG or a PNG and try again.'
    case 'image_undecodable': return 'This image could not be read'
    case 'image_too_small': return variant === 'icon' ? 'The icon must be at least 128 × 128 pixels' : 'The logo must be at least 64 × 16 pixels'
    case 'image_too_large': return 'The image must be at most 4096 × 4096 pixels'
    case 'icon_not_square': return 'The icon must be square'
  }
}

const errorClass = (err: unknown) => (err instanceof Error ? err.name : 'UnknownError')
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

function failure(op: string, err: unknown, message: string) {
  if (err instanceof ServiceNotConfiguredError) {
    return NextResponse.json(serviceUnavailableBody(err.service), { status: 503 })
  }
  if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
  console.error(`[branding] ${op} failed (${errorClass(err)})`)
  return NextResponse.json({ error: message }, { status: 500 })
}

type PendingAsset = { kind: BrandAssetKind; data: BrandAssetInput }

/** Writes one PNG to the blob store under its content-addressed key; the row is written later. */
async function storePng(kind: BrandAssetKind, png: Uint8Array, source: BrandAssetInput['source'], width: number, height: number): Promise<PendingAsset> {
  const hash = sha256(png)
  const { url } = await putPrivateBlob(`branding/${kind}-${hash}.png`, png, 'image/png')
  return { kind, data: { source, blobUrl: url, sha256: hash, width, height, byteSize: png.byteLength } }
}

async function storeIcons(png: Uint8Array, source: BrandAssetInput['source']): Promise<PendingAsset[]> {
  const icons = await deriveIcons(png)
  return Promise.all(icons.map((i) => storePng(`icon_${i.size}` as BrandAssetKind, i.png, source, i.size, i.size)))
}

/** Best-effort removal of blobs no row points at any more (content-addressed keys may be reused). */
async function dropReplaced(before: { blobUrl: string }[], kept: string[]): Promise<void> {
  const keep = new Set(kept)
  await Promise.all(before.filter((r) => !keep.has(r.blobUrl)).map((r) => deletePrivateBlob(r.blobUrl)))
}

async function writeRows(session: Session, puts: PendingAsset[], removes: BrandAssetKind[], action: string, details: string) {
  await inBrandAssetTx(async (tx) => {
    await deleteBrandAssets(removes, session, tx)
    for (const p of puts) await putBrandAsset(p.kind, p.data, session, tx)
    await logAudit(session, action, null, details, tx)
  })
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!BRAND_SETTINGS_ROLES.includes(session.role)) return NextResponse.json(FORBIDDEN, { status: 403 })
  const crossOrigin = rejectCrossOrigin(request)
  if (crossOrigin) return crossOrigin

  const declared = request.headers.get('content-length')
  if (declared !== null && /^\d{1,15}$/.test(declared.trim()) && Number(declared) > BRAND_UPLOAD_LIMITS.maxBodyBytes) {
    return NextResponse.json(TOO_LARGE, { status: 413 })
  }
  if (!getBlobDriver()) return NextResponse.json(serviceUnavailableBody('blob'), { status: 503 })

  try {
    if (!(await checkBrandUploadRateLimit(session.name)).allowed) return NextResponse.json(RATE_LIMITED, { status: 429 })
  } catch (err) {
    return failure('rate limit', err, 'Could not upload the image')
  }

  const read = await readCappedBody(request, BRAND_UPLOAD_LIMITS.maxBodyBytes)
  if (!read.ok) {
    return read.reason === 'too_large' ? NextResponse.json(TOO_LARGE, { status: 413 }) : NextResponse.json(INVALID_UPLOAD, { status: 400 })
  }
  let form: FormData
  try {
    form = await new Response(Buffer.from(read.bytes), { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData()
  } catch {
    return NextResponse.json(INVALID_UPLOAD, { status: 400 })
  }

  const fields: Record<string, unknown> = {}
  for (const [key, value] of form.entries()) {
    if (key === 'file') continue
    if (key in fields || typeof value !== 'string') return NextResponse.json(INVALID_UPLOAD, { status: 400 })
    fields[key] = value
  }
  const files = form.getAll('file')
  if (files.length === 0) return NextResponse.json({ error: 'Choose an image file' }, { status: 400 })
  const parsed = variantSchema.safeParse(fields)
  if (!parsed.success || files.length !== 1 || typeof files[0] === 'string') return NextResponse.json(INVALID_UPLOAD, { status: 400 })
  const variant = parsed.data.variant
  const file = files[0]
  if (file.size === 0) return NextResponse.json({ error: 'Choose an image file' }, { status: 400 })
  if (file.size > BRAND_UPLOAD_LIMITS.maxBytes) return NextResponse.json(TOO_LARGE, { status: 413 })
  if (file.type.split(';')[0].trim().toLowerCase() === 'image/svg+xml' && file.size > BRAND_UPLOAD_LIMITS.maxSvgBytes) {
    return NextResponse.json(SVG_TOO_LARGE, { status: 413 })
  }

  const result = await processBrandImage(new Uint8Array(await file.arrayBuffer()), file.type, variant)
  if (!result.ok) return NextResponse.json({ error: imageErrorMessage(result.code, variant), code: result.code }, { status: result.status })

  let primary: PendingAsset
  let before: Awaited<ReturnType<typeof listBrandAssetRows>>
  const puts: PendingAsset[] = []
  try {
    before = await listBrandAssetRows()
    if (variant === 'icon') {
      puts.push(...(await storeIcons(result.png, 'upload')))
      primary = puts.find((p) => p.kind === 'icon_512')!
    } else {
      primary = await storePng(LOGO_KIND[variant], result.png, 'upload', result.width, result.height)
      puts.push(primary)
      const uploadedIcon = before.some((r) => r.source === 'upload' && (ICON_KINDS as readonly string[]).includes(r.kind))
      if (variant === 'light' && !uploadedIcon) puts.push(...(await storeIcons(result.png, 'derived')))
    }
    await writeRows(session, puts, [], 'branding: uploaded asset',
      `variant=${variant} bytes=${result.png.byteLength} w=${result.width} h=${result.height}`)
  } catch (err) {
    return failure('upload', err, 'Could not save the image')
  }
  invalidateBrandCache()
  const replaced = new Set(puts.map((p) => p.kind))
  await dropReplaced(before.filter((r) => replaced.has(r.kind)), puts.map((p) => p.data.blobUrl))

  return NextResponse.json({
    ok: true,
    asset: { kind: primary.kind, path: brandAssetPath(primary.kind, primary.data.sha256), width: primary.data.width, height: primary.data.height },
  }, { status: 201 })
}

export async function DELETE(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!BRAND_SETTINGS_ROLES.includes(session.role)) return NextResponse.json(FORBIDDEN, { status: 403 })
  const crossOrigin = rejectCrossOrigin(request)
  if (crossOrigin) return crossOrigin

  const params = request.nextUrl.searchParams
  const keys = [...params.keys()]
  const parsed = variantSchema.safeParse(Object.fromEntries(params))
  if (!parsed.success || keys.length !== 1) return NextResponse.json({ error: 'Invalid variant' }, { status: 400 })
  const variant = parsed.data.variant

  let before: Awaited<ReturnType<typeof listBrandAssetRows>>
  const puts: PendingAsset[] = []
  const removes: BrandAssetKind[] = []
  try {
    before = await listBrandAssetRows()
    const icons = before.filter((r) => (ICON_KINDS as readonly string[]).includes(r.kind))
    if (variant === 'dark') {
      removes.push('logo_dark')
    } else if (variant === 'light') {
      removes.push('logo_light', ...icons.filter((r) => r.source === 'derived').map((r) => r.kind))
    } else {
      removes.push(...icons.filter((r) => r.source === 'upload').map((r) => r.kind))
      const light = before.find((r) => r.kind === 'logo_light')
      if (light && removes.length > 0) {
        const bytes = await getPrivateBlobBytes(light.blobUrl)
        if (bytes) puts.push(...(await storeIcons(bytes, 'derived')))
        else console.warn('[branding] light logo unreadable; icons not re-derived')
      }
    }
    await writeRows(session, puts, removes, 'branding: removed asset', `variant=${variant}`)
  } catch (err) {
    return failure('remove asset', err, 'Could not remove the image')
  }
  invalidateBrandCache()
  const touched = new Set<string>([...removes, ...puts.map((p) => p.kind)])
  await dropReplaced(before.filter((r) => touched.has(r.kind)), puts.map((p) => p.data.blobUrl))
  return NextResponse.json({ ok: true })
}
