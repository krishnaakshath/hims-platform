// WL T6: the strict Zod bodies of the admin branding routes (spec §3, §4.2, §6; lane ruling R2).
// Pure (zod and the brand parsers only), so the Settings > Branding form can reuse it client-side.
// Every text value passes the same cleaners as the BRAND_* env layer: control characters stripped
// (CR/LF can never reach an email header), whitespace collapsed, length capped. Values are stored
// as plain text and only ever rendered by React as text.
import { z } from 'zod'
import {
  BRAND_LIMITS, cleanBrandMultiline, cleanBrandText, parseLogoUrl, parseSupportEmail, parseSupportPhone,
} from '@/lib/brand'
import { parseHex } from '@/lib/brand-color'
import { BRAND_EDITABLE_KEYS } from '@/lib/brand-snapshot'

const blank = (v: string | null): boolean => v === null || v.trim() === ''

/** Single-line text, capped at `max` after cleaning; blank → null. Input over twice the cap is rejected. */
const text = (max: number) =>
  z.string().max(max * 2, 'This is too long').nullable().transform((v) => cleanBrandText(v, max))

/** A value with its own parser: blank → null, unparseable → the authored message. */
const parsed = (maxRaw: number, parse: (v: string) => string | null, message: string) =>
  z.string().max(maxRaw, message).nullable().transform((v, ctx) => {
    if (blank(v)) return null
    const out = parse(v as string)
    if (out === null) {
      ctx.addIssue({ code: 'custom', message })
      return z.NEVER
    }
    return out
  })

const emailSignature = z.string().max(BRAND_LIMITS.emailSignature * 2, 'The email signature is too long').nullable()
  .transform((v, ctx) => {
    if (blank(v)) return null
    const lines = (v as string).replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '')
    if (lines.length > BRAND_LIMITS.emailSignatureLines) {
      ctx.addIssue({ code: 'custom', message: `The email signature can have at most ${BRAND_LIMITS.emailSignatureLines} lines` })
      return z.NEVER
    }
    return cleanBrandMultiline(v, BRAND_LIMITS.emailSignature, BRAND_LIMITS.emailSignatureLines)
  })

export const brandSettingsSchema = z.object({
  revision: z.number().int().min(0),
  displayName: text(BRAND_LIMITS.name),
  tagline: text(BRAND_LIMITS.tagline),
  supportEmail: parsed(BRAND_LIMITS.supportEmail * 2, parseSupportEmail, 'Enter a valid support email address'),
  supportPhone: parsed(BRAND_LIMITS.supportPhone * 2, parseSupportPhone, 'Enter a valid support phone number'),
  accentColor: parsed(16, parseHex, 'Enter the accent colour as #rgb or #rrggbb'),
  logoUrl: parsed(BRAND_LIMITS.logoUrl, parseLogoUrl, 'Use an https:// logo address or a path starting with /'),
  loginQuote: text(BRAND_LIMITS.loginQuote),
  loginQuoteAttribution: text(BRAND_LIMITS.loginQuoteAttribution),
  loginShowDepartmentList: z.boolean(),
  portalName: text(BRAND_LIMITS.portalName),
  printHeaderText: text(BRAND_LIMITS.printHeaderText),
  printFooterText: text(BRAND_LIMITS.printFooterText),
  printSignatureLine: text(BRAND_LIMITS.printSignatureLine),
  emailSignature,
  smsName: text(BRAND_LIMITS.smsName),
}).strict()

export type BrandSettingsBody = z.output<typeof brandSettingsSchema>

export const brandResetSchema = z.object({ confirm: z.literal('RESET'), revision: z.number().int().min(0) }).strict()

export const brandOnboardingSchema = z.object({ action: z.enum(['test_signin_done', 'dismiss']) }).strict()

const KNOWN_FIELDS: ReadonlySet<string> = new Set<string>(['revision', ...BRAND_EDITABLE_KEYS])

/**
 * Per-field 400 details that never echo the request: the field is a known key or null (an unknown
 * key's name is input), and the message is one this module authored or a generic 'Invalid value'.
 */
export function brandValidationDetails(error: z.ZodError): { field: string | null; message: string }[] {
  return error.issues.map((issue) => {
    const head = issue.path[0]
    const field = typeof head === 'string' && KNOWN_FIELDS.has(head) ? head : null
    const authored = field !== null && (issue.code === 'custom' || issue.code === 'too_big')
    return { field, message: authored ? issue.message : 'Invalid value' }
  })
}
