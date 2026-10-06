// The single source of every client-visible product identity string: name,
// logo, theme colour, contact address, cookie names and the MFA issuer.
// Values come from per-deployment `BRAND_*` environment variables so one
// codebase can be deployed for many clients; nothing here is client-specific.
//
// Constraints this module honours:
// - It must never throw at import time. It is imported by proxy.ts (which
//   gates every request) and by the auth/session modules, so a malformed env
//   value must degrade to the neutral default, not take the app down.
// - It is pure: no `node:` imports, no `next/headers`, no `server-only`, so it
//   runs in the proxy, route handlers, server components and tests alike.
// - It is SERVER-side config. Client components cannot read `BRAND_*` env
//   (only `NEXT_PUBLIC_*` is inlined into the browser bundle), so the root
//   layout hands `publicBrand()` to <BrandProvider>, and client components
//   read it from there instead of importing this module.
// - Every value is validated (format + length cap) and is only ever rendered
//   as text by React (escaped), never as HTML.

export interface Brand {
  /** Short product name shown in the UI, page titles, emails and SMS. */
  name: string
  /** Full legal entity name, e.g. for printouts. Defaults to `name`. */
  legalName: string
  /** One-line description; used as the default page meta description. */
  tagline: string
  /** Contact address shown to users, or null when not configured. */
  supportEmail: string | null
  /** `https://` absolute or `/`-relative logo URL, or null for a text wordmark. */
  logoUrl: string | null
  /** Validated `#rgb`/`#rrggbb` (lower-cased), or null to keep the stock theme. */
  primaryColor: string | null
  /** `[a-z0-9_]{1,24}`; every cookie this app sets is named `${cookiePrefix}_<kind>`. */
  cookiePrefix: string
  /** Issuer label written into TOTP enrollment QR codes. */
  mfaIssuer: string
  /** Sender name on automated (system-generated) patient messages. */
  systemSenderName: string
}

/** The subset of the brand that is safe and needed in client components. */
export interface PublicBrand {
  name: string
  logoUrl: string | null
}

export const DEFAULT_BRAND_NAME = 'HIMS'
export const DEFAULT_COOKIE_PREFIX = 'hims'
export const DEFAULT_TAGLINE = 'Hospital information management system'

export const BRAND_LIMITS = {
  name: 60,
  legalName: 120,
  tagline: 160,
  supportEmail: 254,
  logoUrl: 2048,
  mfaIssuer: 60,
} as const

export type CookieKind = 'session' | 'patient_session' | 'pending_staff_mfa' | 'pending_patient_mfa' | 'pending_google_oauth'

type Env = Record<string, string | undefined>

const COOKIE_PREFIX_RE = /^[a-z0-9_]{1,24}$/
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const EMAIL_RE = /^[^\s@<>"'(),;:\\[\]]+@[^\s@<>"'(),;:\\[\]]+\.[^\s@<>"'(),;:\\[\]]+$/
// A same-origin path. Deliberately a conservative character set: no quotes,
// backslashes, whitespace or `//` (protocol-relative, i.e. another origin).
const RELATIVE_URL_RE = /^\/(?!\/)[A-Za-z0-9._~\-/%?=&+]*$/

// Strips control characters (incl. CR/LF, so a brand value can never inject
// an email header line), collapses whitespace, trims, and caps the length.
// Returns null when nothing usable is left.
function cleanText(raw: string | undefined, max: number): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  const chars = Array.from(cleaned)
  return chars.length > max ? chars.slice(0, max).join('').trim() : cleaned
}

function parseLogoUrl(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || value.length > BRAND_LIMITS.logoUrl) return null
  if (value.startsWith('/')) return RELATIVE_URL_RE.test(value) ? value : null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

function parseColor(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return HEX_COLOR_RE.test(value) ? value.toLowerCase() : null
}

function parseEmail(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || value.length > BRAND_LIMITS.supportEmail) return null
  return EMAIL_RE.test(value) ? value : null
}

function parseCookiePrefix(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return COOKIE_PREFIX_RE.test(value) ? value : null
}

/**
 * Builds a validated brand from an env-like object. Pure and total: any
 * missing or invalid value falls back to its neutral default; it never throws.
 * `onInvalid` is told the NAME (never the value) of each set-but-rejected var.
 */
export function loadBrand(env: Env, onInvalid?: (varName: string) => void): Brand {
  const get = (key: string): string | undefined => {
    try {
      const v = env?.[key]
      return typeof v === 'string' ? v : undefined
    } catch {
      return undefined
    }
  }
  const reject = (key: string, parsed: unknown) => {
    const raw = get(key)
    if (parsed === null && raw !== undefined && raw.trim() !== '') onInvalid?.(key)
  }

  const name = cleanText(get('BRAND_NAME'), BRAND_LIMITS.name)
  const legalName = cleanText(get('BRAND_LEGAL_NAME'), BRAND_LIMITS.legalName)
  const tagline = cleanText(get('BRAND_TAGLINE'), BRAND_LIMITS.tagline)
  const supportEmail = parseEmail(get('BRAND_SUPPORT_EMAIL'))
  const logoUrl = parseLogoUrl(get('BRAND_LOGO_URL'))
  const primaryColor = parseColor(get('BRAND_PRIMARY_COLOR'))
  const cookiePrefix = parseCookiePrefix(get('BRAND_COOKIE_PREFIX'))
  reject('BRAND_SUPPORT_EMAIL', supportEmail)
  reject('BRAND_LOGO_URL', logoUrl)
  reject('BRAND_PRIMARY_COLOR', primaryColor)
  reject('BRAND_COOKIE_PREFIX', cookiePrefix)

  const finalName = name ?? DEFAULT_BRAND_NAME
  // otpauth:// labels are `issuer:account`; a colon inside the issuer makes
  // authenticator apps mis-split it, so drop colons from the issuer only.
  const mfaIssuer = cleanText(finalName.replace(/:/g, ' '), BRAND_LIMITS.mfaIssuer) ?? DEFAULT_BRAND_NAME

  return {
    name: finalName,
    legalName: legalName ?? finalName,
    tagline: tagline ?? DEFAULT_TAGLINE,
    supportEmail,
    logoUrl,
    primaryColor,
    cookiePrefix: cookiePrefix ?? DEFAULT_COOKIE_PREFIX,
    mfaIssuer,
    systemSenderName: `${finalName} (Automated)`,
  }
}

function loadFromProcessEnv(): Brand {
  try {
    const env = typeof process !== 'undefined' && process.env ? (process.env as Env) : {}
    return loadBrand(env, (varName) => {
      console.warn(`[brand] ${varName} is set but invalid; using the default instead.`)
    })
  } catch {
    return loadBrand({})
  }
}

/** The deployment's brand, read and validated once at module load. */
export const brand: Brand = loadFromProcessEnv()

/**
 * The ONE place cookie names come from. proxy.ts, auth.ts, patient-session.ts
 * and mfa-pending-session.ts must all use this -- a mismatch between the
 * writer and the proxy's reader would silently log everyone out.
 */
export function cookieName(kind: CookieKind, b: Pick<Brand, 'cookiePrefix'> = brand): string {
  return `${b.cookiePrefix}_${kind}`
}

export function publicBrand(b: Brand = brand): PublicBrand {
  return { name: b.name, logoUrl: b.logoUrl }
}

// WCAG relative luminance of a validated #rgb/#rrggbb colour.
function relativeLuminance(hex: string): number {
  const h = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1)
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * CSS overriding the light theme's `--primary` (and a contrasting
 * `--primary-foreground`) with the brand colour, or null when no colour is
 * configured. Built ONLY from the regex-validated hex value, so it is safe to
 * inline into a <style> tag. The dark theme keeps its own tuned primary.
 */
export function brandThemeCss(b: Pick<Brand, 'primaryColor'> = brand): string | null {
  const color = b.primaryColor
  if (!color || !HEX_COLOR_RE.test(color)) return null
  // White text on the colour when that contrasts better than near-black text.
  const L = relativeLuminance(color)
  const whiteContrast = 1.05 / (L + 0.05)
  const blackContrast = (L + 0.05) / 0.05
  const foreground = whiteContrast >= blackContrast ? 'oklch(0.99 0 0)' : 'oklch(0.18 0.01 60)'
  return `:root:not(.dark){--primary:${color};--primary-foreground:${foreground};--ring:${color};}`
}
