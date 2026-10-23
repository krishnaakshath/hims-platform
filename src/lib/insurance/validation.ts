// WS12 T3: the manual verification form (R2), parsed from multipart text fields. Pure and
// client-safe. The bounds here use today only; the query re-checks them against the policy's
// own end date (never after valid_to) with its own clock.
import { z, type ZodError } from 'zod'
import { formatCalendarDate, todayIsoIn } from '../india-time'
import { formatPaise } from '../money'
import { MANUAL_VERIFICATION_MAX_DAYS, VERIFICATION_METHODS, manualValidUntilBounds } from './coverage'

export const MAX_VERIFICATION_AMOUNT_PAISE = 1_000_000_000_000
const NO_POLICY_END = '9999-12-31'

function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}
const isoDate = (message: string) => z.string({ error: message }).refine(isCalendarDate, message)

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)
/** An optional integer form field ('' = absent), parsed from its string, within [0, max]. */
const optionalInt = (max: number, message: string) =>
  z.preprocess(blankToUndefined, z.coerce.number({ error: message }).int(message).min(0, message).max(max, message).optional())
const amount = (label: string) => optionalInt(MAX_VERIFICATION_AMOUNT_PAISE, `${label} must be a whole amount between 0 and ${formatPaise(MAX_VERIFICATION_AMOUNT_PAISE).replace(/\.00$/, '')}`)

export const manualVerificationSchema = z.object({
  result: z.enum(['active', 'inactive'], { error: 'Choose whether the policy is active or not in force' }),
  method: z.enum(VERIFICATION_METHODS, { error: 'Choose how the cover was verified' }),
  reference: z.string({ error: 'Enter the insurer or TPA reference (3 to 64 characters)' }).trim()
    .min(3, 'Enter the insurer or TPA reference (3 to 64 characters)').max(64, 'Enter the insurer or TPA reference (3 to 64 characters)'),
  verifiedOn: isoDate('Enter the verification date as YYYY-MM-DD'),
  validUntil: isoDate('Enter the valid-until date as YYYY-MM-DD'),
  sumInsuredPaise: amount('Sum insured'),
  balancePaise: amount('Balance'),
  copayBp: optionalInt(10_000, 'Co-pay must be between 0% and 100%'),
  roomRentLimitPaise: amount('Room rent limit'),
  icuLimitPaise: amount('ICU limit'),
  note: z.string().trim().max(500, 'Keep the note under 500 characters').optional(),
}).strict().superRefine((v, ctx) => {
  const today = todayIsoIn()
  const { maxIso } = manualValidUntilBounds(today, NO_POLICY_END)
  if (v.verifiedOn > today) ctx.addIssue({ code: 'custom', path: ['verifiedOn'], message: 'The verification date cannot be in the future' })
  else if (v.validUntil < today) ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'Valid until cannot be before today' })
  else if (v.validUntil > maxIso) {
    ctx.addIssue({ code: 'custom', path: ['validUntil'], message: `Valid until can be at most ${MANUAL_VERIFICATION_MAX_DAYS} days from today (${formatCalendarDate(maxIso)})` })
  }
})

export type ManualVerificationInput = z.infer<typeof manualVerificationSchema>

/** The message staff see for a refused form: the authored message of the first issue. */
export function manualVerificationMessage(error: ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid verification details'
  if (issue.code === 'unrecognized_keys') return 'Unexpected field in the form'
  return issue.message
}
