// Request schemas for the coding API (SP6). Client-safe.
import { z } from 'zod'
import { isoDateSchema } from '@/lib/follow-ups/validation'
import { CODE_SYSTEM_KINDS } from '@/lib/coding/code-systems'
import { DIAGNOSIS_TYPES } from '@/lib/coding/status'

const id = z.number().int().positive()
const sequence = z.number().int().min(1).max(99)
const description = z.string().trim().min(1).max(500)
const hasKey = (v: Record<string, unknown>) => Object.values(v).some((x) => x !== undefined)

export const codingStatusRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim') }).strict(),
  z.object({ action: z.literal('assign'), assigneeUserId: id }).strict(),
  z.object({ action: z.literal('release') }).strict(),
  z.object({ action: z.literal('resume') }).strict(),
  z.object({ action: z.literal('mark_coded') }).strict(),
  z.object({ action: z.literal('finalise') }).strict(),
  z.object({ action: z.literal('reopen'), reason: z.string().trim().min(1).max(500) }).strict(),
])
export type CodingStatusRequest = z.infer<typeof codingStatusRequestSchema>

const CODE_OR_DESCRIPTION = 'Choose a code or describe the diagnosis'
const NEEDS_A_FIELD = 'Provide at least one field to change'

export const addDiagnosisSchema = z.object({
  codeId: id.optional(),
  description: description.optional(),
  type: z.enum(DIAGNOSIS_TYPES),
  sequence: sequence.optional(),
}).strict().refine((v) => v.codeId !== undefined || v.description !== undefined, CODE_OR_DESCRIPTION)
export type AddDiagnosisRequest = z.infer<typeof addDiagnosisSchema>

export const updateDiagnosisSchema = z.object({
  codeId: id.optional(),
  type: z.enum(DIAGNOSIS_TYPES).optional(),
  sequence: sequence.optional(),
}).strict().refine(hasKey, NEEDS_A_FIELD)
export type UpdateDiagnosisRequest = z.infer<typeof updateDiagnosisSchema>

export const addProcedureSchema = z.object({
  codeId: id.optional(),
  description: description.optional(),
  performedOn: isoDateSchema,
  performedByProviderId: id.optional(),
  serviceId: id.optional(),
  sequence: sequence.optional(),
}).strict().refine((v) => v.codeId !== undefined || v.description !== undefined, 'Choose a code or describe the procedure')
export type AddProcedureRequest = z.infer<typeof addProcedureSchema>

export const updateProcedureSchema = z.object({
  codeId: id.optional(),
  description: description.optional(),
  performedOn: isoDateSchema.optional(),
  performedByProviderId: id.optional(),
  serviceId: id.optional(),
  sequence: sequence.optional(),
}).strict().refine(hasKey, NEEDS_A_FIELD)
export type UpdateProcedureRequest = z.infer<typeof updateProcedureSchema>

export const raiseQuerySchema = z.object({
  addressedToProviderId: id,
  question: z.string().trim().min(1).max(1000),
}).strict()
export const queryResponseSchema = z.object({ body: z.string().trim().min(1).max(2000) }).strict()
export const queryActionSchema = z.object({ action: z.enum(['close', 'withdraw']) }).strict()

export const codeSearchParamsSchema = z.object({
  kind: z.enum(CODE_SYSTEM_KINDS),
  q: z.string().trim().min(1).max(60),
  on: isoDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict()

export const codeSystemImportSchema = z.object({
  kind: z.enum(CODE_SYSTEM_KINDS),
  version: z.string(),
  name: z.string(),
  licenceNote: z.string().nullable(),
  sourceFileName: z.string().trim().min(1).max(200),
  csv: z.string(),
  commit: z.boolean(),
  makeCurrent: z.boolean(),
}).strict()

export const serviceCodesSchema = z.object({
  codes: z.array(z.object({
    kind: z.enum(CODE_SYSTEM_KINDS),
    code: z.string().trim().min(1).max(20),
    isPrimary: z.boolean(),
  }).strict()).max(20),
}).strict().refine((v) => v.codes.filter((c) => c.isPrimary).length <= 1, 'Only one code can be primary')
  .refine((v) => new Set(v.codes.map((c) => `${c.kind}:${c.code}`)).size === v.codes.length, 'Each code can be mapped once')
