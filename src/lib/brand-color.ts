// Accent colour and WCAG contrast utilities for white-label branding.
// Pure functions, no imports: safe for server, client and tests.

export type Hex = `#${string}`

export interface ThemeAccent {
  primary: Hex
  foreground: Hex
  /** Lowest contrast of `primary` against the page and card backgrounds. */
  ratioOnPage: number
  /** Contrast of `foreground` on `primary`. */
  ratioText: number
}

export interface AccentPalette {
  input: Hex
  light: ThemeAccent
  dark: ThemeAccent
  adjustedLight: boolean
  adjustedDark: boolean
}

// Hex of --background / --card in :root and .dark of src/app/globals.css
// (a test keeps these in sync with the stylesheet).
export const LIGHT_PAGE_BG: Hex = '#fcfaf6'
export const LIGHT_CARD_BG: Hex = '#ffffff'
export const DARK_PAGE_BG: Hex = '#0f0d0b'
export const DARK_CARD_BG: Hex = '#1a1815'
export const ON_ACCENT_LIGHT: Hex = '#fcfcfc'
// oklch(0.18 0.01 60)
export const ON_ACCENT_DARK: Hex = '#15110d'

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

export function parseHex(raw: string): Hex | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!HEX_RE.test(s)) return null
  let h = s.slice(1).toLowerCase()
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  return `#${h}`
}

type Rgb = [number, number, number]

function hexToRgb(hex: Hex): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb
}

function toLinear(c8: number): number {
  const c = c8 / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function fromLinear(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

export function relativeLuminance(hex: Hex): number {
  const [r, g, b] = hexToRgb(hex).map(toLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: Hex, b: Hex): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

export function hexToOklch(hex: Hex): { l: number; c: number; h: number } {
  const [r, g, b] = hexToRgb(hex).map(toLinear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const c = Math.hypot(A, B)
  let h = (Math.atan2(B, A) * 180) / Math.PI
  if (h < 0) h += 360
  return { l: L, c: c < 1e-6 ? 0 : c, h: c < 1e-6 ? 0 : h }
}

const EPS = 1e-6

/** Linear sRGB for an OKLCH colour, unclamped. */
function oklchToLinear(L: number, C: number, H: number): Rgb {
  const hr = (H * Math.PI) / 180
  const A = C * Math.cos(hr)
  const B = C * Math.sin(hr)
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3)
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3)
  const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3)
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

function inGamut(rgb: Rgb): boolean {
  return rgb.every((v) => v >= -EPS && v <= 1 + EPS)
}

function linearToHex(rgb: Rgb): Hex {
  const h = rgb
    .map((v) => {
      const c = Math.min(1, Math.max(0, v))
      return Math.round(fromLinear(c) * 255)
        .toString(16)
        .padStart(2, '0')
    })
    .join('')
  return `#${h}`
}

/** Converts OKLCH to hex, reducing chroma until the colour fits sRGB. */
export function oklchToHex(l: number, c: number, h: number): Hex {
  const L = Math.min(1, Math.max(0, l))
  let rgb = oklchToLinear(L, c, h)
  if (!inGamut(rgb)) {
    let lo = 0
    let hi = c
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(oklchToLinear(L, mid, h))) lo = mid
      else hi = mid
    }
    rgb = oklchToLinear(L, lo, h)
  }
  return linearToHex(rgb)
}

const L_FLOOR = 0.15
const L_CEIL = 0.97
const STEP = 0.01
const FALLBACK_LIGHT: Hex = '#1a1a1a'
const FALLBACK_DARK: Hex = '#f2f2f2'

function bestForeground(primary: Hex): { fg: Hex; ratio: number } {
  const a = contrastRatio(ON_ACCENT_LIGHT, primary)
  const b = contrastRatio(ON_ACCENT_DARK, primary)
  return a >= b ? { fg: ON_ACCENT_LIGHT, ratio: a } : { fg: ON_ACCENT_DARK, ratio: b }
}

function onPage(primary: Hex, bgs: Hex[]): number {
  return Math.min(...bgs.map((bg) => contrastRatio(primary, bg)))
}

function themeAccent(primary: Hex, fg: Hex, bgs: Hex[]): ThemeAccent {
  return {
    primary,
    foreground: fg,
    ratioOnPage: onPage(primary, bgs),
    ratioText: contrastRatio(fg, primary),
  }
}

function deriveLight(input: Hex): { accent: ThemeAccent; adjusted: boolean } {
  const bgs = [LIGHT_PAGE_BG, LIGHT_CARD_BG]
  const ok = (p: Hex) => bestForeground(p).ratio >= 4.5 && onPage(p, bgs) >= 4.5
  const mk = (p: Hex) => themeAccent(p, bestForeground(p).fg, bgs)
  if (ok(input)) return { accent: mk(input), adjusted: false }
  const { l, c, h } = hexToOklch(input)
  for (let L = Math.min(l, L_CEIL) - STEP; L >= L_FLOOR - EPS; L -= STEP) {
    const p = oklchToHex(L, c, h)
    if (ok(p)) return { accent: mk(p), adjusted: true }
  }
  return { accent: themeAccent(FALLBACK_LIGHT, bestForeground(FALLBACK_LIGHT).fg, bgs), adjusted: true }
}

function deriveDark(input: Hex): { accent: ThemeAccent; adjusted: boolean } {
  const bgs = [DARK_PAGE_BG, DARK_CARD_BG]
  const ok = (p: Hex) => contrastRatio(ON_ACCENT_DARK, p) >= 4.5 && onPage(p, bgs) >= 4.5
  const mk = (p: Hex) => themeAccent(p, ON_ACCENT_DARK, bgs)
  if (ok(input)) return { accent: mk(input), adjusted: false }
  const { l, c, h } = hexToOklch(input)
  for (let L = Math.max(l, L_FLOOR) + STEP; L <= L_CEIL + EPS; L += STEP) {
    const p = oklchToHex(L, c, h)
    if (ok(p)) return { accent: mk(p), adjusted: true }
  }
  return { accent: mk(FALLBACK_DARK), adjusted: true }
}

export function deriveAccentPalette(input: Hex): AccentPalette {
  const light = deriveLight(input)
  const dark = deriveDark(input)
  return {
    input,
    light: light.accent,
    dark: dark.accent,
    adjustedLight: light.adjusted,
    adjustedDark: dark.adjusted,
  }
}
