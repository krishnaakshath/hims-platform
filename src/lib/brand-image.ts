// SERVER ONLY. Brand upload image handling (Settings > Branding): magic-byte sniffing, the SVG
// safety pre-check, and decoding + re-encoding every upload to a metadata-free PNG with sharp.
// The product never stores or serves user SVG: a checked SVG is rasterised here, and no sharp
// call ever sees SVG text that has not passed checkSvgSafe. Errors are fixed codes, never input.
import sharp, { type Sharp } from 'sharp'

export type BrandUploadVariant = 'light' | 'dark' | 'icon'

export const BRAND_UPLOAD_LIMITS = {
  maxBytes: 1_048_576,
  maxSvgBytes: 262_144,
  maxBodyBytes: 1_572_864,
  maxInputPixels: 16_777_216,
  maxDim: 4096,
  logoMin: { w: 64, h: 16 },
  iconMin: 128,
  logoBox: { w: 1024, h: 256 },
} as const

/** Square favicon sizes derived from an uploaded icon (match /icon/<n> and apple-icon). */
export const BRAND_ICON_SIZES = [32, 180, 192, 512] as const
export type BrandIconSize = (typeof BRAND_ICON_SIZES)[number]

/** Processed icon sources are kept no larger than the largest derived icon. */
const ICON_BOX = 512
const ICON_ASPECT_MIN = 0.8
const ICON_ASPECT_MAX = 1.25
/** An SVG is rasterised so its long edge renders at this many pixels. */
const SVG_RENDER_LONG_EDGE = 1024
const SVG_BASE_DENSITY = 72

export type SniffedImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml'

export type BrandImageErrorCode =
  | 'type_not_allowed'
  | 'type_mismatch'
  | 'svg_unsafe'
  | 'image_undecodable'
  | 'image_too_small'
  | 'image_too_large'
  | 'icon_not_square'

export type ProcessBrandImageResult =
  | { ok: true; png: Uint8Array; width: number; height: number }
  | { ok: false; status: 415 | 422; code: BrandImageErrorCode }

const ALLOWED_TYPES: readonly SniffedImageType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']

/** How much of the input the SVG sniff reads (room for an XML declaration and a licence comment). */
const SNIFF_TEXT_BYTES = 16_384

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false
  return prefix.every((b, i) => bytes[at + i] === b)
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

/** True when the text's first element is `<svg`, optionally after a BOM, an XML declaration and comments. */
function looksLikeSvg(text: string): boolean {
  let s = text.replace(/^﻿/, '')
  for (;;) {
    s = s.replace(/^\s+/, '')
    if (s.startsWith('<?xml')) {
      const end = s.indexOf('?>')
      if (end < 0) return false
      s = s.slice(end + 2)
    } else if (s.startsWith('<!--')) {
      const end = s.indexOf('-->', 4)
      if (end < 0) return false
      s = s.slice(end + 3)
    } else {
      break
    }
  }
  return /^<svg[\s>/]/i.test(s)
}

/** Identifies an image from its leading bytes. Anything other than PNG, JPEG, WebP or SVG is null. */
export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  if (startsWith(bytes, PNG_MAGIC)) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp'
  if (bytes.length === 0) return null
  // Lenient decode of the head only: the strict UTF-8 check belongs to processBrandImage
  // (invalid UTF-8 in a sniffed SVG is svg_unsafe, not a type mismatch).
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, SNIFF_TEXT_BYTES))
  return looksLikeSvg(head) ? 'image/svg+xml' : null
}

/**
 * Rejects SVG features that can run script, pull external resources or expand entities.
 * Case-insensitive pattern checks over the whole text; deliberately strict (a false positive
 * only means the admin uploads a PNG instead). `reason` is a fixed code, never echoed input.
 */
export function checkSvgSafe(text: string): { ok: true } | { ok: false; reason: string } {
  const s = text.toLowerCase()
  // Element names may carry a namespace prefix (<s:script xmlns:s="http://www.w3.org/2000/svg">).
  const el = (names: string) => new RegExp(`<(?:[a-z0-9_.-]+:)?(?:${names})`)
  const checks: [RegExp, string][] = [
    [/<!doctype/, 'doctype'],
    [/<!entity/, 'entity'],
    // The XML parser decodes character references before librsvg sees the text, so
    // `u&#114;l(` or `&#106;avascript:` would slip past every check below. DOCTYPE is
    // banned, so only the five predefined entities can be legitimate.
    [/&#/, 'entity'],
    [/&(?!(?:amp|lt|gt|quot|apos);)/, 'entity'],
    [el('script'), 'script'],
    [/javascript:/, 'script'],
    [el('foreignobject'), 'foreign_object'],
    [el('iframe|embed|object'), 'embedded_content'],
    [/on[a-z]+\s*=/, 'event_handler'],
    [/xml:base/, 'external_ref'],
    [/data:/, 'data_uri'],
    // Any href / xlink:href (including on <image>, <use>, <feImage> and <?xml-stylesheet?>)
    // whose value does not start with '#'. Whitespace inside the lookahead keeps
    // backtracking from skipping past a leading quote.
    [/href\s*=(?!\s*["']?\s*#)/, 'external_ref'],
    [/url\((?!\s*["']?\s*#)/, 'external_ref'],
    [/@import/, 'external_ref'],
    // url( inside a <style> element (closed or not); url(#g) in an attribute stays allowed.
    [/<(?:[a-z0-9_.-]+:)?style[^>]*>(?:(?!<\/(?:[a-z0-9_.-]+:)?style)[\s\S])*?url\(/, 'style_url'],
    // CSS escapes (u\72l(...)) could smuggle a url() past the checks above.
    [/\\/, 'css_escape'],
  ]
  for (const [re, reason] of checks) {
    if (re.test(s)) return { ok: false, reason }
  }
  return { ok: true }
}

function normaliseDeclaredType(declared: string): string {
  return declared.split(';')[0].trim().toLowerCase()
}

const fail = (status: 415 | 422, code: BrandImageErrorCode): ProcessBrandImageResult => ({ ok: false, status, code })

/** Size and shape rules for a decoded (or rendered) image of the given dimensions. */
function checkDimensions(width: number, height: number, variant: BrandUploadVariant): BrandImageErrorCode | null {
  const L = BRAND_UPLOAD_LIMITS
  if (width > L.maxDim || height > L.maxDim) return 'image_too_large'
  if (variant === 'icon') {
    const aspect = width / height
    if (aspect < ICON_ASPECT_MIN || aspect > ICON_ASPECT_MAX) return 'icon_not_square'
    if (width < L.iconMin || height < L.iconMin) return 'image_too_small'
  } else if (width < L.logoMin.w || height < L.logoMin.h) {
    return 'image_too_small'
  }
  return null
}

function outputBox(variant: BrandUploadVariant): { width: number; height: number } {
  return variant === 'icon'
    ? { width: ICON_BOX, height: ICON_BOX }
    : { width: BRAND_UPLOAD_LIMITS.logoBox.w, height: BRAND_UPLOAD_LIMITS.logoBox.h }
}

async function encodePng(
  image: Sharp,
  variant: BrandUploadVariant,
): Promise<{ png: Uint8Array; width: number; height: number }> {
  // sharp writes no metadata (EXIF, ICC, text chunks) unless asked to.
  const { data, info } = await image
    .resize({ ...outputBox(variant), fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true })
  return { png: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height }
}

async function processSvg(bytes: Uint8Array, variant: BrandUploadVariant): Promise<ProcessBrandImageResult> {
  if (bytes.length > BRAND_UPLOAD_LIMITS.maxSvgBytes) return fail(422, 'image_too_large')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return fail(422, 'svg_unsafe')
  }
  if (!checkSvgSafe(text).ok) return fail(422, 'svg_unsafe')

  // Only checked text reaches sharp from here on.
  const source = Buffer.from(text, 'utf-8')
  const opts = { limitInputPixels: BRAND_UPLOAD_LIMITS.maxInputPixels, failOn: 'error' as const }
  try {
    const meta = await sharp(source, { ...opts, density: SVG_BASE_DENSITY }).metadata()
    if (!meta.width || !meta.height) return fail(422, 'image_undecodable')
    const longEdge = Math.max(meta.width, meta.height)
    const density = Math.min(100_000, Math.max(1, (SVG_BASE_DENSITY * SVG_RENDER_LONG_EDGE) / longEdge))
    const width = Math.round((meta.width * density) / SVG_BASE_DENSITY)
    const height = Math.round((meta.height * density) / SVG_BASE_DENSITY)
    const bad = checkDimensions(width, height, variant)
    if (bad) return fail(422, bad)
    const out = await encodePng(sharp(source, { ...opts, density }), variant)
    return { ok: true, ...out }
  } catch {
    return fail(422, 'image_undecodable')
  }
}

async function processRaster(bytes: Uint8Array, variant: BrandUploadVariant): Promise<ProcessBrandImageResult> {
  const opts = {
    limitInputPixels: BRAND_UPLOAD_LIMITS.maxInputPixels,
    failOn: 'error' as const,
    animated: false, // first frame only
    autoOrient: true, // apply EXIF orientation before it is stripped
  }
  try {
    const meta = await sharp(bytes, opts).metadata()
    const width = meta.autoOrient?.width ?? meta.width
    const height = meta.autoOrient?.height ?? meta.height
    if (!width || !height) return fail(422, 'image_undecodable')
    const bad = checkDimensions(width, height, variant)
    if (bad) return fail(422, bad)
    const out = await encodePng(sharp(bytes, opts), variant)
    return { ok: true, ...out }
  } catch {
    return fail(422, 'image_undecodable')
  }
}

/**
 * Validates an uploaded brand image and re-encodes it to PNG. The declared type must be one of
 * PNG, JPEG, WebP or SVG (415 type_not_allowed) and must agree with the sniffed bytes
 * (415 type_mismatch). Logos fit inside 1024x256; icons inside 512x512.
 */
export async function processBrandImage(
  bytes: Uint8Array,
  declaredType: string,
  variant: BrandUploadVariant,
): Promise<ProcessBrandImageResult> {
  const declared = normaliseDeclaredType(declaredType)
  if (!(ALLOWED_TYPES as readonly string[]).includes(declared)) return fail(415, 'type_not_allowed')
  if (bytes.length > BRAND_UPLOAD_LIMITS.maxBytes) return fail(422, 'image_too_large')
  if (sniffImageType(bytes) !== declared) return fail(415, 'type_mismatch')
  return declared === 'image/svg+xml' ? processSvg(bytes, variant) : processRaster(bytes, variant)
}

/** Square favicon PNGs from a processed icon: contained on a transparent square at each size. */
export async function deriveIcons(png: Uint8Array): Promise<{ size: BrandIconSize; png: Uint8Array }[]> {
  return Promise.all(
    BRAND_ICON_SIZES.map(async (size) => {
      const data = await sharp(png, { limitInputPixels: BRAND_UPLOAD_LIMITS.maxInputPixels, failOn: 'error' })
        .ensureAlpha()
        .resize({ width: size, height: size, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer()
      return { size, png: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
    }),
  )
}
