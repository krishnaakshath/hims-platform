import { describe, it, expect } from 'vitest'
import {
  codingStatusRequestSchema, addDiagnosisSchema, updateDiagnosisSchema, addProcedureSchema, updateProcedureSchema, raiseQuerySchema,
  queryResponseSchema, queryActionSchema, codeSearchParamsSchema, codeSystemImportSchema, serviceCodesSchema,
} from '@/lib/coding/validation'
import { CODING_ERROR_STATUS, CODING_ERROR_MESSAGE, type CodingWriteError } from '@/lib/coding/errors'

describe('coding request schemas', () => {
  it('reopen needs a reason; assign needs a user', () => {
    expect(codingStatusRequestSchema.safeParse({ action: 'reopen' }).success).toBe(false)
    expect(codingStatusRequestSchema.safeParse({ action: 'reopen', reason: 'payer query' }).success).toBe(true)
    expect(codingStatusRequestSchema.safeParse({ action: 'assign' }).success).toBe(false)
    expect(codingStatusRequestSchema.safeParse({ action: 'assign', assigneeUserId: 4 }).success).toBe(true)
    expect(codingStatusRequestSchema.safeParse({ action: 'claim', extra: 1 }).success).toBe(false)
    expect(codingStatusRequestSchema.safeParse({ action: 'raise_query' }).success).toBe(false)
  })
  it('a diagnosis needs a code or a description, and is strict', () => {
    expect(addDiagnosisSchema.safeParse({ type: 'primary' }).success).toBe(false)
    expect(addDiagnosisSchema.safeParse({ type: 'primary', description: 'Chest pain' }).success).toBe(true)
    expect(addDiagnosisSchema.safeParse({ type: 'primary', codeId: 3, codingStatus: 'coded' }).success).toBe(false)
    expect(addDiagnosisSchema.safeParse({ type: 'primary', codeId: 3, sequence: 100 }).success).toBe(false)
    const r = addDiagnosisSchema.safeParse({ type: 'primary' })
    expect(!r.success && r.error.issues[0].message).toBe('Choose a code or describe the diagnosis')
  })
  it('updates need at least one field', () => {
    expect(updateDiagnosisSchema.safeParse({}).success).toBe(false)
    expect(updateDiagnosisSchema.safeParse({ type: 'secondary' }).success).toBe(true)
    expect(updateProcedureSchema.safeParse({}).success).toBe(false)
    expect(updateProcedureSchema.safeParse({ performedOn: '2026-10-07' }).success).toBe(true)
  })
  it('procedures validate dates and the code-or-description rule', () => {
    expect(addProcedureSchema.safeParse({ performedOn: '2026-10-07' }).success).toBe(false)
    expect(addProcedureSchema.safeParse({ performedOn: '2026-02-30', codeId: 1 }).success).toBe(false)
    expect(addProcedureSchema.safeParse({ performedOn: '2026-10-07', codeId: 1, serviceId: 2, performedByProviderId: 3 }).success).toBe(true)
  })
  it('queries, responses and actions', () => {
    expect(raiseQuerySchema.safeParse({ addressedToProviderId: 1, question: ' Why? ' }).data).toEqual({ addressedToProviderId: 1, question: 'Why?' })
    expect(raiseQuerySchema.safeParse({ addressedToProviderId: 1, question: 'x'.repeat(1001) }).success).toBe(false)
    expect(queryResponseSchema.safeParse({ body: '' }).success).toBe(false)
    expect(queryActionSchema.safeParse({ action: 'close' }).success).toBe(true)
    expect(queryActionSchema.safeParse({ action: 'delete' }).success).toBe(false)
  })
  it('code search coerces and defaults limit', () => {
    expect(codeSearchParamsSchema.parse({ kind: 'icd10', q: ' E11 ' })).toEqual({ kind: 'icd10', q: 'E11', limit: 20 })
    expect(codeSearchParamsSchema.parse({ kind: 'icd10', q: 'E11', limit: '5' }).limit).toBe(5)
    expect(codeSearchParamsSchema.safeParse({ kind: 'icd10', q: 'E11', limit: '51' }).success).toBe(false)
    expect(codeSearchParamsSchema.safeParse({ kind: 'nope', q: 'E11' }).success).toBe(false)
  })
  it('import request is strict', () => {
    const ok = { kind: 'icd10', version: 'v1', name: 'n', licenceNote: null, sourceFileName: 'a.csv', csv: 'x', commit: false, makeCurrent: false }
    expect(codeSystemImportSchema.safeParse(ok).success).toBe(true)
    expect(codeSystemImportSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false)
    expect(codeSystemImportSchema.safeParse({ ...ok, sourceFileName: '' }).success).toBe(false)
  })
  it('service codes allow one primary and no duplicates', () => {
    const c = (code: string, isPrimary = false) => ({ kind: 'icd10pcs', code, isPrimary })
    expect(serviceCodesSchema.safeParse({ codes: [c('A', true), c('B')] }).success).toBe(true)
    expect(serviceCodesSchema.safeParse({ codes: [c('A', true), c('B', true)] }).success).toBe(false)
    expect(serviceCodesSchema.safeParse({ codes: [c('A'), c('A')] }).success).toBe(false)
    expect(serviceCodesSchema.safeParse({ codes: Array.from({ length: 21 }, (_, i) => c(`C${i}`)) }).success).toBe(false)
  })
})

describe('coding errors', () => {
  it('every error has a status and a message', () => {
    for (const k of Object.keys(CODING_ERROR_STATUS)) expect(CODING_ERROR_MESSAGE[k as CodingWriteError].length).toBeGreaterThan(0)
    expect(Object.keys(CODING_ERROR_MESSAGE).sort()).toEqual(Object.keys(CODING_ERROR_STATUS).sort())
    expect(CODING_ERROR_STATUS.not_found).toBe(404); expect(CODING_ERROR_STATUS.locked).toBe(409)
    expect(CODING_ERROR_STATUS.validation_failed).toBe(422); expect(CODING_ERROR_STATUS.code_required).toBe(400)
    expect(CODING_ERROR_MESSAGE.locked).toBe('Coding for this visit is closed to changes')
  })
})
