// WS7 T10 (spec D16): who a hospital broadcast goes to. Pure (client-safe): the filter shape, its
// strict Zod schema, query-string parsing, the per-patient send/skip decision and the summary
// counts the wizard shows ("212 match · 18 opted out · 7 no phone"). The DB query lives in
// src/lib/queries/broadcasts.ts.
import { z } from 'zod'
import { BROADCAST_NOTICE_MAX } from '@/lib/notify/templates'

export interface HospitalAudienceFilters {
  /** Had an encounter in this department in the last 12 months. */
  departmentId?: number
  /** Had an encounter with this doctor in the last 12 months. */
  providerId?: number
  ageMin?: number
  ageMax?: number
  /** Currently admitted in this ward. */
  ward?: string
  followUpDue?: 'overdue' | 'due_7_days'
  /** Preferred language code (patients.preferred_language). */
  language?: string
  /** 3–6 leading digits of the PIN code. */
  pinCodePrefix?: string
  // Trial filters: accepted only when trialsEnabled().
  trialId?: string
  overallStatus?: 'green' | 'yellow' | 'red'
  formStatus?: 'sent' | 'partial' | 'completed' | 'none'
}

export const TRIAL_FILTER_KEYS = ['trialId', 'overallStatus'] as const
export const BROADCAST_MESSAGE_MAX = BROADCAST_NOTICE_MAX

const id = z.number().int().positive()
const age = z.number().int().min(0).max(120)

export const hospitalAudienceFiltersSchema = z
  .object({
    departmentId: id.optional(),
    providerId: id.optional(),
    ageMin: age.optional(),
    ageMax: age.optional(),
    ward: z.string().trim().min(1).max(64).optional(),
    followUpDue: z.enum(['overdue', 'due_7_days']).optional(),
    language: z.string().regex(/^[a-z]{2,3}$/).optional(),
    pinCodePrefix: z.string().regex(/^\d{3,6}$/).optional(),
    trialId: z.string().min(1).max(64).optional(),
    overallStatus: z.enum(['green', 'yellow', 'red']).optional(),
    formStatus: z.enum(['sent', 'partial', 'completed', 'none']).optional(),
  })
  .strict()
  .refine((f) => f.ageMin === undefined || f.ageMax === undefined || f.ageMin <= f.ageMax, { message: 'Minimum age must not exceed maximum age', path: ['ageMin'] })

/** True when the filters use a trial-only key (trial or screening status). */
export function usesTrialFilters(f: HospitalAudienceFilters): boolean {
  return TRIAL_FILTER_KEYS.some((k) => f[k] !== undefined)
}

const NUMERIC_KEYS = new Set(['departmentId', 'providerId', 'ageMin', 'ageMax'])

export type ParsedAudienceQuery =
  | { ok: true; filters: HospitalAudienceFilters }
  | { ok: false; code: 'trial_filters_disabled' | 'invalid_filters' }

/** Reads filters from a query string. Empty values are ignored; unknown keys are refused. */
export function parseAudienceQuery(params: URLSearchParams, opts: { trialsEnabled: boolean }): ParsedAudienceQuery {
  const raw: Record<string, unknown> = {}
  for (const [k, v] of params) {
    if (v.trim() === '') continue
    raw[k] = NUMERIC_KEYS.has(k) ? (/^\d+$/.test(v) ? Number(v) : v) : v
  }
  return validateAudienceFilters(raw, opts)
}

/** Validates a filter object (from a body or a query string) against the trials flag. */
export function validateAudienceFilters(raw: unknown, opts: { trialsEnabled: boolean }): ParsedAudienceQuery {
  const parsed = hospitalAudienceFiltersSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, code: 'invalid_filters' }
  if (!opts.trialsEnabled && usesTrialFilters(parsed.data)) return { ok: false, code: 'trial_filters_disabled' }
  return { ok: true, filters: parsed.data }
}

export type RecipientClass = 'send' | 'opted_out' | 'no_phone' | 'archived'

/**
 * One patient's fate in a broadcast. `phone` must already be the normalised (usable) number or
 * null; `smsOff` is the patient's SMS channel preference turned off. Archived wins, then opt-out,
 * then a missing phone.
 */
export function classifyRecipient(p: { phone: string | null; optedOut: boolean; smsOff: boolean; archived: boolean }): RecipientClass {
  if (p.archived) return 'archived'
  if (p.optedOut || p.smsOff) return 'opted_out'
  if (!p.phone) return 'no_phone'
  return 'send'
}

export interface AudienceSummary {
  /** Every patient matching the filters (archived charts excluded). */
  match: number
  optedOut: number
  noPhone: number
  /** Patients who will be sent the notice. */
  sendable: number
}

export function summariseAudience(classes: readonly RecipientClass[]): AudienceSummary {
  const s: AudienceSummary = { match: 0, optedOut: 0, noPhone: 0, sendable: 0 }
  for (const c of classes) {
    if (c === 'archived') continue
    s.match += 1
    if (c === 'opted_out') s.optedOut += 1
    else if (c === 'no_phone') s.noPhone += 1
    else s.sendable += 1
  }
  return s
}

/** "212 match · 18 opted out · 7 no phone" */
export function audienceSummaryLine(s: AudienceSummary): string {
  return `${s.match} match · ${s.optedOut} opted out · ${s.noPhone} no phone`
}

const FOLLOW_UP_LABEL = { overdue: 'Follow-up overdue', due_7_days: 'Follow-up due in 7 days' } as const
const OVERALL_LABEL = { green: 'Meets', yellow: 'Needs verification', red: 'Potential exclusion' } as const
const FORM_LABEL = { sent: 'Form sent, not started', partial: 'Form partly completed', completed: 'Form completed', none: 'No form sent' } as const

/** Human-readable filter summary for history. Names come from the caller (ids are never shown). */
export function describeAudienceFilters(
  f: HospitalAudienceFilters,
  names: { department?: string | null; provider?: string | null; language?: string | null; trial?: string | null } = {},
  opts: { trialsEnabled: boolean } = { trialsEnabled: true },
): string[] {
  const parts: string[] = []
  if (f.departmentId !== undefined) parts.push(`Department: ${names.department ?? 'unknown'} (last 12 months)`)
  if (f.providerId !== undefined) parts.push(`Doctor: ${names.provider ?? 'unknown'} (last 12 months)`)
  if (f.ageMin !== undefined && f.ageMax !== undefined) parts.push(`Age ${f.ageMin}–${f.ageMax}`)
  else if (f.ageMin !== undefined) parts.push(`Age ${f.ageMin} and above`)
  else if (f.ageMax !== undefined) parts.push(`Age up to ${f.ageMax}`)
  if (f.ward) parts.push(`Admitted in ${f.ward}`)
  if (f.followUpDue) parts.push(FOLLOW_UP_LABEL[f.followUpDue])
  if (f.language) parts.push(`Language: ${names.language ?? f.language}`)
  if (f.pinCodePrefix) parts.push(`PIN code starts with ${f.pinCodePrefix}`)
  if (opts.trialsEnabled) {
    if (f.trialId) parts.push(`Trial: ${names.trial ?? f.trialId}`)
    if (f.overallStatus) parts.push(`Screening: ${OVERALL_LABEL[f.overallStatus]}`)
  }
  if (f.formStatus) parts.push(FORM_LABEL[f.formStatus])
  return parts.length > 0 ? parts : ['All patients']
}

export type BroadcastOutcome = 'sent' | 'skipped' | 'failed'

/**
 * One sendable recipient's result from sendNotification's per-channel attempts: any channel sent
 * -> sent; else any channel failed or only logged (no provider configured) -> failed; else
 * (every channel skipped, e.g. a per-channel opt-out) -> skipped.
 */
export function broadcastOutcome(attempts: readonly { status: string }[]): BroadcastOutcome {
  if (attempts.some((a) => a.status === 'sent')) return 'sent'
  if (attempts.some((a) => a.status === 'failed' || a.status === 'log_only')) return 'failed'
  return 'skipped'
}
