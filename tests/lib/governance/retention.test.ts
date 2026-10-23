// WS8 T14 (spec D18): the retention schedule constant and the erasure check built on it.
import { describe, it, expect } from 'vitest'
import { RETENTION_SCHEDULE, retentionBlocksErasure } from '@/lib/governance/retention'

const NONE = { hasFinancial: false, hasMlc: false, lastEncounterDate: null }

describe('RETENTION_SCHEDULE', () => {
  it('has the default periods, every one marked pending legal review', () => {
    expect(Object.fromEntries(RETENTION_SCHEDULE.map((r) => [r.category, r.years]))).toEqual({
      medical_records: 3,
      mlc_records: 10,
      financial_records: 8,
      audit_log: 8,
      notification_log: 2,
      portal_uploads: 3,
    })
    expect(RETENTION_SCHEDULE.every((r) => r.status === 'default_pending_legal_review' && r.basis.length > 0)).toBe(true)
  })
})

describe('retentionBlocksErasure', () => {
  it('no retained records: no reasons', () => {
    expect(retentionBlocksErasure(NONE, '2026-10-24')).toEqual([])
  })

  it('financial records block erasure', () => {
    const reasons = retentionBlocksErasure({ ...NONE, hasFinancial: true }, '2026-10-24')
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/8 years/)
  })

  it('a medico-legal chart blocks erasure', () => {
    const reasons = retentionBlocksErasure({ ...NONE, hasMlc: true }, '2026-10-24')
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/medico-legal/)
  })

  it('a visit within the last 3 years blocks erasure; an older one does not', () => {
    expect(retentionBlocksErasure({ ...NONE, lastEncounterDate: '2024-01-10' }, '2026-10-24')).toEqual([
      expect.stringContaining('until 2027-01-10'),
    ])
    expect(retentionBlocksErasure({ ...NONE, lastEncounterDate: '2023-10-24' }, '2026-10-24')).toEqual([])
    expect(retentionBlocksErasure({ ...NONE, lastEncounterDate: '2023-10-25' }, '2026-10-24')).toHaveLength(1)
  })

  it('lists every reason that applies', () => {
    expect(retentionBlocksErasure({ hasFinancial: true, hasMlc: true, lastEncounterDate: '2026-01-01' }, '2026-10-24')).toHaveLength(3)
  })
})
