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
//   layout hands `toPublicBrand(await getBrand())` (src/lib/brand-resolve.ts,
//   src/lib/brand-server.ts) to <BrandProvider>, and client components read it
//   from there instead of importing this module.
// - WL T4: this module is the ENV layer only. The brand an admin stores under
//   Settings > Branding is layered over it per field by resolveBrand and read
//   per request with getBrand(); only the cookie prefix stays env-only.
// - Every value is validated (format + length cap) and is only ever rendered
//   as text by React (escaped), never as HTML.
import { deriveAccentPalette, parseHex, type AccentPalette } from '@/lib/brand-color'

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
  /** Line shown on the sign-in brand panel (BRAND_LOGIN_QUOTE / _ATTRIBUTION). */
  loginQuote: LoginQuote
  /** Contact phone shown to users, or null. */
  supportPhone: string | null
  /** Logo for the dark theme, or null to use `logoUrl` in both themes. */
  logoDarkUrl: string | null
  /** What the UI calls the patient portal (default "Patient portal"). */
  portalName: string
  /** Sign-in page options (lane ruling R2). */
  login: { showDepartmentList: boolean }
  /** Printed-document identity (header chain: print header text, billing legal name, practice name, legal name). */
  print: BrandPrint
  /** Plain-text signature appended to every email body (up to 4 lines), or null. */
  emailSignature: string | null
  /** `hospitalName` in SMS templates (defaults to `name`). */
  smsName: string
  /** WCAG-adjusted light/dark palette derived from `primaryColor`, or null for the stock theme. */
  accent: AccentPalette | null
}

export interface BrandPrint {
  headerText: string
  /** Second header line: the billing address, else the practice site. */
  subline: string | null
  footerText: string | null
  signatureLine: string | null
  address: string | null
  gstin: string | null
  rohiniId: string | null
  hfrId: string | null
  logoUrl: string | null
}

/** What a printed document needs from the brand: the print identity plus the product name. */
export type PrintIdentity = BrandPrint & { name: string }

/**
 * What invoices and receipts take from the brand (spec D3): only the logo, footer and signature
 * line. Their legal name, address and GSTIN stay from billing settings.
 */
export type BillingDocumentMarks = Pick<BrandPrint, 'logoUrl' | 'footerText' | 'signatureLine'>

/** The print identity of a resolved brand (pass `await getBrand()` from a server page). */
export function printIdentity(b: Pick<Brand, 'name' | 'print'>): PrintIdentity {
  return { ...b.print, name: b.name }
}

export interface LoginQuote {
  text: string
  /** Who said it, or null for an unattributed line (e.g. the hospital's own). */
  attribution: string | null
}

/**
 * The subset of the brand that is safe and needed in client components (built by
 * `toPublicBrand` in src/lib/brand-resolve.ts). No blob URLs, print identity, cookie or MFA values.
 */
export interface PublicBrand {
  name: string
  tagline: string
  logoUrl: string | null
  logoDarkUrl: string | null
  portalName: string
  supportEmail: string | null
  supportPhone: string | null
  loginQuote: LoginQuote
  login: { showDepartmentList: boolean }
}

// Florence Nightingale, Notes on Hospitals (3rd ed., 1863), preface. Public domain.
export const DEFAULT_LOGIN_QUOTE: LoginQuote = {
  text: 'The very first requirement in a Hospital is that it should do the sick no harm.',
  attribution: 'Florence Nightingale, Notes on Hospitals',
}

export const DEFAULT_BRAND_NAME = 'HIMS'
export const DEFAULT_COOKIE_PREFIX = 'hims'
export const DEFAULT_TAGLINE = 'Hospital information management system'
export const DEFAULT_PORTAL_NAME = 'Patient portal'

export const BRAND_LIMITS = {
  name: 60,
  legalName: 120,
  tagline: 160,
  supportEmail: 254,
  logoUrl: 2048,
  mfaIssuer: 60,
  loginQuote: 200,
  loginQuoteAttribution: 100,
  supportPhone: 20,
  portalName: 40,
  printHeaderText: 120,
  printFooterText: 200,
  printSignatureLine: 80,
  emailSignature: 300,
  emailSignatureLines: 4,
  smsName: 30,
} as const

export type CookieKind = 'session' | 'patient_session' | 'pending_staff_mfa' | 'pending_patient_mfa' | 'pending_google_oauth'

type Env = Record<string, string | undefined>

const COOKIE_PREFIX_RE = /^[a-z0-9_]{1,24}$/
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const EMAIL_RE = /^[^\s@<>"'(),;:\\[\]]+@[^\s@<>"'(),;:\\[\]]+\.[^\s@<>"'(),;:\\[\]]+$/
// A same-origin path. Deliberately a conservative character set: no quotes,
// backslashes, whitespace or `//` (protocol-relative, i.e. another origin).
const RELATIVE_URL_RE = /^\/(?!\/)[A-Za-z0-9._~\-/%?=&+]*$/
const PHONE_RE = /^\+?[0-9][0-9 -]{5,18}$/

// Strips control characters (incl. CR/LF, so a brand value can never inject
// an email header line), collapses whitespace, trims, and caps the length.
// Returns null when nothing usable is left.
function cleanText(raw: string | null | undefined, max: number): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  const chars = Array.from(cleaned)
  return chars.length > max ? chars.slice(0, max).join('').trim() : cleaned
}

/** Exported for reuse (WL T4): `cleanText`, the single-line brand text cleaner. */
export const cleanBrandText = cleanText

/**
 * Multi-line brand text (the email signature): keeps `\n` line breaks, strips every other control
 * character, trims each line, drops blank lines, keeps at most `maxLines` lines and `max` chars.
 */
export function cleanBrandMultiline(raw: string | null | undefined, max: number, maxLines: number): string | null {
  if (typeof raw !== 'string') return null
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
    .map((l) => l.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, maxLines)
  if (lines.length === 0) return null
  const joined = lines.join('\n')
  const chars = Array.from(joined)
  return chars.length > max ? chars.slice(0, max).join('').trim() || null : joined
}

/**
 * A logo URL: `https://` with a hostname and no credentials, or a same-origin `/path`. Used for
 * BRAND_LOGO_URL and for the stored `logoUrl` (lane ruling R2).
 */
export function parseLogoUrl(raw: string | null | undefined): string | null {
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

export function parseSupportPhone(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return value.length <= BRAND_LIMITS.supportPhone && PHONE_RE.test(value) ? value : null
}

export function parseSupportEmail(raw: string | null | undefined): string | null {
  return parseEmail(raw ?? undefined)
}

/** The TOTP issuer for a brand name: colons dropped (otpauth labels are `issuer:account`). */
export function mfaIssuerFor(name: string): string {
  return cleanText(name.replace(/:/g, ' '), BRAND_LIMITS.mfaIssuer) ?? DEFAULT_BRAND_NAME
}

/** The validated accent palette for a `#rgb`/`#rrggbb` colour, or null. */
export function accentFor(color: string | null | undefined): AccentPalette | null {
  const hex = typeof color === 'string' ? parseHex(color) : null
  return hex ? deriveAccentPalette(hex) : null
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
  // A configured quote replaces the default wholesale: its attribution is
  // only what is configured alongside it (never Nightingale's name on
  // someone else's words).
  const quoteText = cleanText(get('BRAND_LOGIN_QUOTE'), BRAND_LIMITS.loginQuote)
  const loginQuote: LoginQuote = quoteText
    ? { text: quoteText, attribution: cleanText(get('BRAND_LOGIN_QUOTE_ATTRIBUTION'), BRAND_LIMITS.loginQuoteAttribution) }
    : DEFAULT_LOGIN_QUOTE
  reject('BRAND_SUPPORT_EMAIL', supportEmail)
  reject('BRAND_LOGO_URL', logoUrl)
  reject('BRAND_PRIMARY_COLOR', primaryColor)
  reject('BRAND_COOKIE_PREFIX', cookiePrefix)

  const finalName = name ?? DEFAULT_BRAND_NAME
  // otpauth:// labels are `issuer:account`; a colon inside the issuer makes
  // authenticator apps mis-split it, so drop colons from the issuer only.
  const mfaIssuer = mfaIssuerFor(finalName)
  const finalLegalName = legalName ?? finalName

  return {
    name: finalName,
    legalName: finalLegalName,
    tagline: tagline ?? DEFAULT_TAGLINE,
    supportEmail,
    logoUrl,
    primaryColor,
    cookiePrefix: cookiePrefix ?? DEFAULT_COOKIE_PREFIX,
    mfaIssuer,
    systemSenderName: `${finalName} (Automated)`,
    loginQuote,
    // WL T4: the fields an admin can also store. Their env layer is the built-in default.
    supportPhone: null,
    logoDarkUrl: null,
    portalName: DEFAULT_PORTAL_NAME,
    login: { showDepartmentList: true },
    print: {
      headerText: finalLegalName, subline: null, footerText: null, signatureLine: null,
      address: null, gstin: null, rohiniId: null, hfrId: null, logoUrl,
    },
    emailSignature: null,
    smsName: finalName,
    accent: accentFor(primaryColor),
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

/**
 * The ENV layer of the brand (BRAND_* plus built-in defaults), read and validated once at module
 * load. Server code that renders the brand should use `await getBrand()` (src/lib/brand-server.ts),
 * which layers the stored Settings > Branding values over this. Only the cookie prefix is env-only.
 */
export const envBrand: Brand = loadFromProcessEnv()

/**
 * The ONE place cookie names come from. proxy.ts, auth.ts, patient-session.ts
 * and mfa-pending-session.ts must all use this -- a mismatch between the
 * writer and the proxy's reader would silently log everyone out.
 */
export function cookieName(kind: CookieKind, b: Pick<Brand, 'cookiePrefix'> = envBrand): string {
  return `${b.cookiePrefix}_${kind}`
}

/** Appends the plain-text email signature after the standard `-- ` separator (spec D13). */
export function appendEmailSignature(body: string, signature: string | null): string {
  return signature ? `${body}\n\n-- \n${signature}` : body
}

const CSS_HEX_RE = /^#[0-9a-f]{6}$/

/**
 * The accent theme for the root layout's <style id="brand-theme">, or null for the stock theme
 * (lane ruling R5). `--brand` (both themes) carries the colour as entered into the decorative
 * sign-in surfaces; the light and dark themes get their WCAG-adjusted primary, foreground and ring.
 * Every value must be a lower-case #rrggbb, so nothing but a colour can reach the <style> tag.
 */
export function brandThemeCss(accent: AccentPalette | null): string | null {
  if (!accent) return null
  const { input, light, dark } = accent
  const values = [input, light?.primary, light?.foreground, dark?.primary, dark?.foreground]
  if (!values.every((v) => typeof v === 'string' && CSS_HEX_RE.test(v))) return null
  return (
    `:root{--brand:${input};}` +
    `:root:not(.dark){--primary:${light.primary};--primary-foreground:${light.foreground};--ring:${light.primary};}` +
    `:root.dark,:root .dark{--primary:${dark.primary};--primary-foreground:${dark.foreground};--ring:${dark.primary};}`
  )
}
