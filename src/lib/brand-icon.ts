// Pure helpers behind the app icon family (favicon PNG/SVG, Apple touch icon,
// web app manifest and the theme-color meta tag).
//
// Everything here takes brand VALUES as parameters and never imports the
// global `brand` singleton, so the same functions can later be fed from a
// database-backed, per-hospital brand without change. No `node:` imports and
// no Next APIs: it runs in route handlers, the proxy and unit tests alike.
//
// The mark ("pulse plus"): a heavy rounded plus with a heartbeat trace cut
// through it in the tile colour. It reads as a plus at 16px and as a plus
// carrying a pulse from 32px up, and it is the same for every hospital; only
// the colours follow the brand.

/** The product blue (globals.css --primary, oklch(0.42 0.1 250)). */
export const DEFAULT_ICON_COLOR = '#194f81'
export const DEFAULT_SHORT_NAME = 'HIMS'
/** Chrome stays legible down to this many characters under a home-screen icon. */
export const SHORT_NAME_MAX = 12

const WHITE = '#ffffff'
// Never pure black: the client asked for no black anywhere in the brand.
const DARK_FALLBACK = '#0f1e2e'
// Representative browser chrome behind a tab favicon.
const LIGHT_CHROME = '#ffffff'
const DARK_CHROME = '#202124'
// Below this the tile would melt into the tab strip, so it gets an edge ring.
const CHROME_MIN_CONTRAST = 1.35
// WCAG 1.4.11 non-text contrast for a graphical object.
const GLYPH_MIN_CONTRAST = 3

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

export interface BrandIconInput {
  /** `#rgb`/`#rrggbb`, or null/undefined for the product default. */
  primaryColor?: string | null
}

export interface BrandIconPalette {
  /** Tile fill (the brand colour, normalised to lower-case #rrggbb). */
  background: string
  /** Glyph colour: white, or a deep shade of the brand on light colours. */
  foreground: string
  /** Edge ring drawn inside the tile when it lacks contrast with tab chrome. */
  ring: string | null
  /** theme-color for light UI (the brand colour itself). */
  themeColorLight: string
  /** theme-color for dark UI (a deep shade of the brand). */
  themeColorDark: string
}

type Rgb = [number, number, number]

function normalizeHex(color: string | null | undefined): string | null {
  if (typeof color !== 'string') return null
  const v = color.trim()
  if (!HEX_COLOR_RE.test(v)) return null
  const h = v.slice(1).toLowerCase()
  return '#' + (h.length === 3 ? h.split('').map((c) => c + c).join('') : h)
}

function toRgb(hex: string): Rgb {
  const h = normalizeHex(hex)!.slice(1)
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb
}

function toHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')
}

/** Mixes `a` toward `b` by `t` (0 = a, 1 = b) in sRGB. */
function mix(a: string, b: string, t: number): string {
  const x = toRgb(a)
  const y = toRgb(b)
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb)
}

/** WCAG 2.x relative luminance of a `#rgb`/`#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.x contrast ratio (1..21) between two `#rgb`/`#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * Colours for the icon tile. Total: an unset or invalid colour falls back to
 * the product blue; the glyph is white unless white fails 3:1 on the brand
 * colour, in which case it becomes a deep shade of that colour (or a deep
 * navy if even the shade is not dark enough).
 */
export function brandIconPalette(input: BrandIconInput = {}): BrandIconPalette {
  const background = normalizeHex(input.primaryColor) ?? DEFAULT_ICON_COLOR

  let foreground = WHITE
  if (contrastRatio(background, WHITE) < GLYPH_MIN_CONTRAST) {
    const shade = mix(background, '#000000', 0.78)
    foreground = contrastRatio(background, shade) >= 4.5 ? shade : DARK_FALLBACK
  }

  let ring: string | null = null
  if (contrastRatio(background, LIGHT_CHROME) < CHROME_MIN_CONTRAST) {
    ring = mix(background, '#000000', 0.35)
  } else if (contrastRatio(background, DARK_CHROME) < CHROME_MIN_CONTRAST) {
    ring = mix(background, WHITE, 0.4)
  }

  return {
    background,
    foreground,
    ring,
    themeColorLight: background,
    themeColorDark: mix(background, '#000000', 0.72),
  }
}

/**
 * A short (<= 12 chars) app name for the manifest / home screen. Keeps the
 * whole name when it fits, else the first word when that fits, else a
 * code-point-safe truncation; empty or whitespace names fall back to HIMS.
 */
export function brandShortName(name: string | null | undefined): string {
  const clean = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim() : ''
  if (!clean) return DEFAULT_SHORT_NAME
  const chars = Array.from(clean)
  if (chars.length <= SHORT_NAME_MAX) return clean
  const first = clean.split(' ')[0]
  if (Array.from(first).length >= 3 && Array.from(first).length <= SHORT_NAME_MAX) return first
  return chars.slice(0, SHORT_NAME_MAX).join('').trim()
}

/**
 * The pulse-plus glyph on a 32-unit grid: a heavy rounded plus (two
 * overlapping 11-unit bars) with a heartbeat trace cut through it in the
 * tile colour -- flat, a sharp up/down spike through the vertical bar, flat.
 * At 16px the plus carries the read; from 32px up the trace appears.
 */
export const PLUS_BAR = 11
export const PLUS_LENGTH = 22
export const PLUS_RADIUS = 2.6
export const PULSE_PATH = 'M7.5 16.5H12.3L14.4 11.2L17.6 21.8L19.7 16.5H24.5'
export const PULSE_STROKE = 2.3

export interface BrandIconSvgOptions {
  /** `rounded` for browser favicons; `square` (full bleed) for Apple/maskable icons, which the OS masks itself. */
  shape?: 'rounded' | 'square'
  /** Glyph scale around the centre; < 1 adds padding (Apple / maskable safe zone). */
  glyphScale?: number
}

/**
 * The icon as a standalone SVG document. Built only from the validated
 * palette colours and numeric constants, so it carries no user text.
 */
export function brandIconSvg(palette: BrandIconPalette, opts: BrandIconSvgOptions = {}): string {
  const shape = opts.shape ?? 'rounded'
  const scale = Number.isFinite(opts.glyphScale) && opts.glyphScale! > 0 ? opts.glyphScale! : 1
  const rx = shape === 'rounded' ? 7 : 0
  const transform = scale === 1 ? '' : ` transform="translate(16 16) scale(${scale}) translate(-16 -16)"`
  const ring = palette.ring && shape === 'rounded'
    ? `<rect x="0.75" y="0.75" width="30.5" height="30.5" rx="${rx - 0.5}" fill="none" stroke="${palette.ring}" stroke-width="1.5"/>`
    : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">` +
    `<rect width="32" height="32" rx="${rx}" fill="${palette.background}"/>` +
    ring +
    `<g${transform}>` +
    `<rect x="${16 - PLUS_BAR / 2}" y="${16 - PLUS_LENGTH / 2}" width="${PLUS_BAR}" height="${PLUS_LENGTH}" rx="${PLUS_RADIUS}" fill="${palette.foreground}"/>` +
    `<rect x="${16 - PLUS_LENGTH / 2}" y="${16 - PLUS_BAR / 2}" width="${PLUS_LENGTH}" height="${PLUS_BAR}" rx="${PLUS_RADIUS}" fill="${palette.foreground}"/>` +
    `<path d="${PULSE_PATH}" fill="none" stroke="${palette.background}" stroke-width="${PULSE_STROKE}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</g>` +
    `</svg>`
  )
}

/** The SVG as a data URI, for embedding in an ImageResponse <img>. */
export function brandIconDataUri(palette: BrandIconPalette, opts?: BrandIconSvgOptions): string {
  return `data:image/svg+xml;base64,${btoaUtf8(brandIconSvg(palette, opts))}`
}

function btoaUtf8(s: string): string {
  // The SVG is pure ASCII (hex colours + numbers), but stay safe anyway.
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf-8').toString('base64')
  return btoa(unescape(encodeURIComponent(s)))
}
