// WL T4: layers the stored brand (Settings > Branding) over the env brand, field by field
// (spec §2 D1: DB value -> BRAND_* env -> built-in default; D3/D4 for the legal name and print
// header; lane rulings R2/R3). Pure: no DB, no Next APIs, so client code (BrandProvider's default)
// and tests can import it.
//
// The snapshot carries each asset's blob URL. Nothing here copies it into the Brand: assets become
// content-addressed `/branding/<kind>-<sha16>.png` paths, served by the public /branding route.
import {
  accentFor, BRAND_LIMITS, cleanBrandMultiline, cleanBrandText, mfaIssuerFor, parseLogoUrl, parseSupportEmail,
  parseSupportPhone, type Brand, type LoginQuote, type PublicBrand,
} from '@/lib/brand'
import { parseHex } from '@/lib/brand-color'
import type { BrandAssetKind, BrandSnapshot } from '@/lib/brand-snapshot'

const SHA256_RE = /^[0-9a-f]{64}$/

/** `/branding/logo-light-<first 16 hex of sha256>.png` (kind `_` -> `-`). */
export function brandAssetPath(kind: BrandAssetKind, sha256: string): string {
  return `/branding/${kind.replace(/_/g, '-')}-${sha256.slice(0, 16)}.png`
}

export function resolveBrand(env: Brand, snap: BrandSnapshot | null): Brand {
  if (!snap) return env
  const s = snap.settings
  const billing = snap.billing
  const practice = snap.practice
  const text = (v: string | null | undefined, max: number) => cleanBrandText(v, max)

  const assetPath = (kind: BrandAssetKind): string | null => {
    const row = snap.assets.find((a) => a.kind === kind)
    return row && SHA256_RE.test(row.sha256) ? brandAssetPath(kind, row.sha256) : null
  }

  const name = text(s.displayName, BRAND_LIMITS.name) ?? env.name
  // loadBrand defaults legalName to the env name, so an env legal name equal to the env name is
  // treated as unset: the legal name then follows the (possibly stored) display name.
  const envLegalName = env.legalName !== env.name ? env.legalName : null
  const legalName = text(billing?.legalName, BRAND_LIMITS.legalName) ?? envLegalName ?? name
  const logoUrl = assetPath('logo_light') ?? parseLogoUrl(s.logoUrl) ?? env.logoUrl
  const accentHex = (typeof s.accentColor === 'string' ? parseHex(s.accentColor) : null) ?? env.primaryColor
  const quoteText = text(s.loginQuote, BRAND_LIMITS.loginQuote)
  const loginQuote: LoginQuote = quoteText
    ? { text: quoteText, attribution: text(s.loginQuoteAttribution, BRAND_LIMITS.loginQuoteAttribution) }
    : env.loginQuote
  const address = text(billing?.address, 500)

  return {
    name,
    legalName,
    tagline: text(s.tagline, BRAND_LIMITS.tagline) ?? env.tagline,
    supportEmail: parseSupportEmail(s.supportEmail) ?? env.supportEmail,
    logoUrl,
    primaryColor: accentHex,
    // D5: env only, whatever the snapshot carries.
    cookiePrefix: env.cookiePrefix,
    mfaIssuer: mfaIssuerFor(name),
    systemSenderName: `${name} (Automated)`,
    loginQuote,
    supportPhone: parseSupportPhone(s.supportPhone) ?? env.supportPhone,
    logoDarkUrl: assetPath('logo_dark') ?? env.logoDarkUrl,
    portalName: text(s.portalName, BRAND_LIMITS.portalName) ?? env.portalName,
    login: { showDepartmentList: s.loginShowDepartmentList !== false },
    print: {
      // D4: print header text -> billing legal name -> practice name -> env legal name (-> name).
      headerText: text(s.printHeaderText, BRAND_LIMITS.printHeaderText)
        ?? text(billing?.legalName, BRAND_LIMITS.legalName)
        ?? text(practice?.practiceName, BRAND_LIMITS.printHeaderText)
        ?? legalName,
      subline: address ?? text(practice?.practiceSite, 200),
      footerText: text(s.printFooterText, BRAND_LIMITS.printFooterText) ?? env.print.footerText,
      signatureLine: text(s.printSignatureLine, BRAND_LIMITS.printSignatureLine) ?? env.print.signatureLine,
      address,
      gstin: text(billing?.gstin, 32),
      rohiniId: text(billing?.rohiniId, 64),
      hfrId: text(billing?.hfrId, 64),
      logoUrl,
    },
    emailSignature: cleanBrandMultiline(s.emailSignature, BRAND_LIMITS.emailSignature, BRAND_LIMITS.emailSignatureLines) ?? env.emailSignature,
    smsName: text(s.smsName, BRAND_LIMITS.smsName) ?? name,
    accent: accentFor(accentHex),
  }
}

/** The client-safe subset handed to <BrandProvider>. Exactly the PublicBrand keys. */
export function toPublicBrand(b: Brand): PublicBrand {
  return {
    name: b.name,
    tagline: b.tagline,
    logoUrl: b.logoUrl,
    logoDarkUrl: b.logoDarkUrl,
    portalName: b.portalName,
    supportEmail: b.supportEmail,
    supportPhone: b.supportPhone,
    loginQuote: b.loginQuote,
    login: { showDepartmentList: b.login.showDepartmentList },
  }
}

// WL T11: first-run checklist state for admins (spec D18). Reads only booleans out of the snapshot,
// so the result is safe to hand to a client component (no blob URLs, no field values).
export type BrandOnboardingKey = 'name' | 'logo' | 'colour' | 'contact' | 'signin'
export interface BrandOnboardingStatus {
  items: { key: BrandOnboardingKey; done: boolean; href: string }[]
  complete: boolean
  dismissed: boolean
}

export function brandOnboardingStatus(snap: BrandSnapshot): BrandOnboardingStatus {
  const s = snap.settings
  const set = (v: string | null | undefined) => typeof v === 'string' && v.trim() !== ''
  const items: BrandOnboardingStatus['items'] = [
    { key: 'name', done: set(s.displayName), href: '/settings/branding#identity' },
    { key: 'logo', done: snap.assets.some((a) => a.kind === 'logo_light') || set(s.logoUrl), href: '/settings/branding#logo' },
    { key: 'colour', done: set(s.accentColor), href: '/settings/branding#colour' },
    { key: 'contact', done: set(s.supportPhone) || set(s.supportEmail), href: '/settings/branding#contact' },
    { key: 'signin', done: s.onboardingTestSigninAt != null, href: '/login' },
  ]
  return { items, complete: items.every((i) => i.done), dismissed: s.onboardingDismissedAt != null }
}
