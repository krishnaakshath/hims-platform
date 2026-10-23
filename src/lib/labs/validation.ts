// zod schemas for every SP5 request body. Client-safe: no DB or node: imports.
import { z } from 'zod'
import { isoDateSchema, followUpIntervalSchema, followUpReasonSchema } from '@/lib/follow-ups/validation'
import type { FollowUpInterval } from '@/lib/follow-ups/rules'
import { isIndianStateCode, isValidPinCode } from '@/lib/india/reference'
import { normalizePhone } from '@/lib/india/phone'
import { SAMPLE_TYPES, SAMPLE_CONTAINERS } from '@/lib/labs/catalog'
import { HHMM_PATTERN, RESCHEDULE_REASONS, VISIT_CANCEL_REASONS } from '@/lib/home-collection/rules'

const positiveInt = z.number().int().positive()
const uniqueIds = (max: number) =>
  z
    .array(positiveInt)
    .min(1)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, 'Each item may appear only once')
const hhmm = z.string().regex(HHMM_PATTERN, 'Use HH:MM (24-hour)')
const optionalText = (max: number) => z.string().trim().max(max).optional()

// ── Results, cancel, receive ────────────────────────────────────────────────

const LAB_RESULT_FLAGS = ['normal', 'abnormal', 'critical'] as const

const singleValueResultSchema = z
  .object({
    value: z.string().trim().min(1).max(200),
    unit: optionalText(40),
    referenceRange: optionalText(120),
    flag: z.enum(LAB_RESULT_FLAGS),
    notes: optionalText(1000),
  })
  .strict()
export type SingleValueResultRequest = z.infer<typeof singleValueResultSchema>

// WS4 T9 (spec 3.3 items 18-19): a test with analytes is entered one value per analyte. A flag
// override raises the automatic flag (never lowers it) or supplies one where there is none.
export const ANALYTE_VALUE_MAX = 60
export const FLAG_REASON_MIN = 5
export const FLAG_REASON_MAX = 200
export const ANALYTE_RESULTS_MAX = 40
const analyteResultEntrySchema = z
  .object({
    analyteId: positiveInt,
    value: z.string().trim().min(1).max(ANALYTE_VALUE_MAX),
    flagOverride: z
      .object({ flag: z.enum(LAB_RESULT_FLAGS), reason: z.string().trim().min(FLAG_REASON_MIN).max(FLAG_REASON_MAX) })
      .strict()
      .optional(),
  })
  .strict()

export const analyteResultSchema = z
  .object({
    analytes: z
      .array(analyteResultEntrySchema)
      .min(1)
      .max(ANALYTE_RESULTS_MAX)
      .refine((a) => new Set(a.map((e) => e.analyteId)).size === a.length, 'Each analyte may appear only once'),
    notes: optionalText(1000),
  })
  .strict()
export type AnalyteResultRequest = z.infer<typeof analyteResultSchema>

export const labResultSchema = z.union([singleValueResultSchema, analyteResultSchema])
export type LabResultRequest = z.infer<typeof labResultSchema>
export const isAnalyteResultRequest = (r: LabResultRequest): r is AnalyteResultRequest => 'analytes' in r
// end WS4 T9

export const labOrderCancelSchema = z.object({ reason: z.string().trim().min(1).max(300) }).strict()

export const receiveSampleSchema = z.object({ sampleId: z.string().trim().min(1).max(32) }).strict()

// ── Doctor's order (requisition) ───────────────────────────────────────────

// WS1 T10: order priority (the worklist shows stat, then urgent, first).
export const LAB_ORDER_PRIORITIES = ['routine', 'urgent', 'stat'] as const
export type LabOrderPriority = (typeof LAB_ORDER_PRIORITIES)[number]
export const LAB_CLINICAL_NOTES_MAX = 500

export interface CreateLabRequisitionRequest {
  labTestIds: number[]
  followUp: { interval: FollowUpInterval; reason: string } | null
  originatingEncounterId: number | null
  // WS1 T10
  priority: LabOrderPriority
  clinicalNotes: string | null
  /** null: fasting when any ordered test requires it (lane ruling R3). */
  fastingRequired: boolean | null
  // end WS1 T10
}

const legacyRequisitionSchema = z
  .object({ labTestId: positiveInt })
  .strict()
  .transform((b): CreateLabRequisitionRequest => ({
    labTestIds: [b.labTestId], followUp: null, originatingEncounterId: null, priority: 'routine', clinicalNotes: null, fastingRequired: null,
  }))

const multiRequisitionSchema = z
  .object({
    labTestIds: uniqueIds(20),
    followUp: z.object({ interval: followUpIntervalSchema, reason: followUpReasonSchema }).strict().nullable().optional(),
    originatingEncounterId: positiveInt.optional(),
    // WS1 T10
    priority: z.enum(LAB_ORDER_PRIORITIES).optional(),
    clinicalNotes: z.string().trim().max(LAB_CLINICAL_NOTES_MAX).optional(),
    fastingRequired: z.boolean().optional(),
    // end WS1 T10
  })
  .strict()
  .transform((b): CreateLabRequisitionRequest => ({
    labTestIds: b.labTestIds,
    followUp: b.followUp ? { interval: b.followUp.interval as FollowUpInterval, reason: b.followUp.reason } : null,
    originatingEncounterId: b.originatingEncounterId ?? null,
    priority: b.priority ?? 'routine',
    clinicalNotes: b.clinicalNotes ? b.clinicalNotes : null,
    fastingRequired: b.fastingRequired ?? null,
  }))

export const createLabRequisitionSchema = z.union([legacyRequisitionSchema, multiRequisitionSchema])

// ── Lab setup ───────────────────────────────────────────────────────────────

export const servicePinsRequestSchema = z
  .object({ pins: z.string().max(5000), areaLabel: optionalText(80) })
  .strict()

export const servicePinPatchSchema = z.object({ isActive: z.boolean() }).strict()

export const collectionWindowSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    startTime: hhmm,
    endTime: hhmm,
    capacity: z.number().int().min(1).max(50),
    sortOrder: z.number().int().min(0).max(99).optional(),
  })
  .strict()
  .refine((w) => w.startTime < w.endTime, { path: ['endTime'], message: 'The window must end after it starts' })
export type CollectionWindowInput = z.infer<typeof collectionWindowSchema>

export const collectionWindowPatchSchema = z
  .object({
    label: z.string().trim().min(1).max(40).optional(),
    startTime: hhmm.optional(),
    endTime: hhmm.optional(),
    capacity: z.number().int().min(1).max(50).optional(),
    sortOrder: z.number().int().min(0).max(99).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((w) => Object.values(w).some((v) => v !== undefined), 'Nothing to change')
  .refine((w) => w.startTime === undefined || w.endTime === undefined || w.startTime < w.endTime, {
    path: ['endTime'],
    message: 'The window must end after it starts',
  })
export type CollectionWindowPatch = z.infer<typeof collectionWindowPatchSchema>

export const labTestSetupSchema = z
  .object({
    sampleType: z.enum(SAMPLE_TYPES).nullable().optional(),
    container: z.enum(SAMPLE_CONTAINERS).nullable().optional(),
    serviceId: positiveInt.nullable().optional(),
    isActive: z.boolean().optional(), // Foundations T10
  })
  .strict()
  .refine((s) => Object.values(s).some((v) => v !== undefined), 'Nothing to change')
export type LabTestSetupRequest = z.infer<typeof labTestSetupSchema>

// ── Home collection ─────────────────────────────────────────────────────────

export const visitAddressSchema = z
  .object({
    line1: z.string().trim().min(1).max(200),
    line2: optionalText(200),
    city: z.string().trim().min(1).max(100),
    district: optionalText(100),
    stateCode: z.string().trim().refine(isIndianStateCode, 'Pick a valid state'),
    pinCode: z.string().trim().refine(isValidPinCode, 'Enter a valid 6-digit PIN code'),
    landmark: optionalText(200),
  })
  .strict()
export type VisitAddress = z.infer<typeof visitAddressSchema>

const contactPhoneSchema = z.string().transform((s, ctx) => {
  const phone = normalizePhone(s, { allowLandline: true })
  if (!phone) {
    ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number' })
    return z.NEVER
  }
  return phone
})

export const bookHomeCollectionSchema = z
  .object({
    patientId: z.string().trim().min(1).max(40),
    labOrderIds: uniqueIds(20),
    visitDate: isoDateSchema,
    windowId: positiveInt,
    address: visitAddressSchema,
    contactPhone: contactPhoneSchema,
    notes: optionalText(300),
  })
  .strict()
export type BookHomeCollectionRequest = z.infer<typeof bookHomeCollectionSchema>

export const rescheduleHomeCollectionSchema = z
  .object({ visitDate: isoDateSchema, windowId: positiveInt, reason: z.enum(RESCHEDULE_REASONS), note: optionalText(300) })
  .strict()
export type RescheduleHomeCollectionRequest = z.infer<typeof rescheduleHomeCollectionSchema>

export const cancelHomeCollectionSchema = z
  .object({ reason: z.enum(VISIT_CANCEL_REASONS), note: optionalText(300) })
  .strict()
export type CancelHomeCollectionRequest = z.infer<typeof cancelHomeCollectionSchema>

export const assignCollectorSchema = z.object({ collectorUserId: positiveInt.nullable() }).strict()

export const collectHomeVisitSchema = z
  .object({ sampleIds: z.array(z.string().trim().min(1).max(32)).min(1).max(20) })
  .strict()

// Foundations T8: the master notices opt-out and/or per-channel switches; at least one key.
export const notificationPreferenceSchema = z
  .object({ optOut: z.boolean().optional(), sms: z.boolean().optional(), whatsapp: z.boolean().optional(), email: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change')

// ── WS4 T8: analyte definitions (Settings → Lab setup → Analytes) ───────────

// numeric(14,4) holds |x| < 1e10.
const rangeBound = z.number().finite().gt(-1e10).lt(1e10).nullable()
const optionList = z.array(z.string().trim().min(1).max(40)).max(20).nullable()

const analyteRangeSchema = z
  .object({
    sex: z.enum(['any', 'male', 'female']),
    ageMinDays: z.number().int().min(0).max(54_750),
    ageMaxDays: z.number().int().min(1).max(54_750).nullable(),
    normalLow: rangeBound,
    normalHigh: rangeBound,
    criticalLow: rangeBound,
    criticalHigh: rangeBound,
    displayText: z.string().trim().min(1).max(60).nullable(),
  })
  .strict()
  .refine((r) => r.ageMaxDays === null || r.ageMaxDays > r.ageMinDays, { path: ['ageMaxDays'], message: 'The age band must end after it starts' })
  .refine((r) => {
    // criticalLow ≤ normalLow ≤ normalHigh ≤ criticalHigh, wherever present.
    const present = [r.criticalLow, r.normalLow, r.normalHigh, r.criticalHigh].filter((v): v is number => v !== null)
    return present.every((v, i) => i === 0 || present[i - 1] <= v)
  }, { message: 'Range limits must run critical low, normal low, normal high, critical high' })

const bandsOverlap = (a: { ageMinDays: number; ageMaxDays: number | null }, b: { ageMinDays: number; ageMaxDays: number | null }) =>
  (a.ageMaxDays === null || b.ageMinDays < a.ageMaxDays) && (b.ageMaxDays === null || a.ageMinDays < b.ageMaxDays)

const analyteDefinitionSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,15}$/, 'Analyte codes are capital letters, digits or _ (up to 16)'),
    name: z.string().trim().min(1).max(80),
    unit: z.string().trim().min(1).max(20).nullable(),
    valueType: z.enum(['numeric', 'option', 'text']),
    decimals: z.number().int().min(0).max(4).nullable(),
    loincCode: z.string().trim().min(1).max(20).nullable(),
    options: optionList,
    abnormalOptions: optionList,
    criticalOptions: optionList,
    ranges: z.array(analyteRangeSchema).max(12),
  })
  .strict()
  .refine((a) => a.valueType !== 'option' || (a.options !== null && a.options.length > 0), { path: ['options'], message: 'A choice analyte needs its choices' })
  .refine((a) => [...(a.abnormalOptions ?? []), ...(a.criticalOptions ?? [])].every((o) => (a.options ?? []).includes(o)), {
    path: ['abnormalOptions'], message: 'Abnormal and critical choices must be among the choices',
  })
  .refine((a) => a.valueType === 'numeric' || a.ranges.every((r) => [r.normalLow, r.normalHigh, r.criticalLow, r.criticalHigh].every((v) => v === null)), {
    path: ['ranges'], message: 'Only numeric analytes have numeric limits',
  })
  .refine((a) => a.ranges.every((r, i) => a.ranges.every((o, j) => j <= i || o.sex !== r.sex || !bandsOverlap(r, o))), {
    path: ['ranges'], message: 'Two ranges for the same sex overlap in age',
  })

export const analyteDefinitionsSchema = z
  .array(analyteDefinitionSchema)
  .max(40)
  .refine((defs) => new Set(defs.map((d) => d.code)).size === defs.length, 'Each analyte code may appear only once')
export type AnalyteDefinitionInput = z.infer<typeof analyteDefinitionSchema>

export const labTestAnalytesRequestSchema = z.object({ analytes: analyteDefinitionsSchema }).strict()
// end WS4 T8
