import { describe, expect, it } from 'vitest'
import { admissionDepositPaise, computeLedger, type LedgerEntry } from '@/lib/billing/ledger'

const at = (s: string) => new Date(s)
const e = (kind: LedgerEntry['kind'], id: number, when: string, amountPaise: number, admissionId: number | null = null): LedgerEntry =>
  ({ kind, id, number: `${kind}-${id}`, at: at(when), amountPaise, admissionId })

describe('patient ledger', () => {
  it('runs the balance and splits outstanding from credit', () => {
    const r = computeLedger([
      { kind: 'advance', id: 1, number: 'RCT/26-27/000001', at: new Date('2026-10-20T05:00:00Z'), amountPaise: 50_000_00, admissionId: 9 },
      { kind: 'invoice', id: 1, number: 'INV/26-27/000001', at: new Date('2026-10-22T05:00:00Z'), amountPaise: 80_000_00, admissionId: 9 },
    ])
    expect(r.rows.map((x) => x.balancePaise)).toEqual([-50_000_00, 30_000_00])
    expect(r.summary).toMatchObject({ outstandingPaise: 30_000_00, creditBalancePaise: 0 })
  })
  it('a credit note reverses its invoice', () => {
    const r = computeLedger([e('invoice', 1, '2026-10-20T05:00:00Z', 100_00), e('credit_note', 1, '2026-10-21T05:00:00Z', 100_00), e('receipt', 2, '2026-10-22T05:00:00Z', 40_00)])
    expect(r.summary).toEqual({ invoicedPaise: 100_00, creditedPaise: 100_00, receivedPaise: 40_00, refundedPaise: 0, balancePaise: -40_00, outstandingPaise: 0, creditBalancePaise: 40_00, insurerSettledPaise: 0, writtenOffPaise: 0 /* SP7 */ })
  })
  it('a refund pays the credit back out', () => {
    const r = computeLedger([e('receipt', 1, '2026-10-20T05:00:00Z', 40_00), e('refund', 1, '2026-10-21T05:00:00Z', 40_00)])
    expect(r.summary).toMatchObject({ refundedPaise: 40_00, balancePaise: 0, outstandingPaise: 0, creditBalancePaise: 0 })
  })
  it('ledger sum above 2^31 is exact', () => {
    const r = computeLedger([e('invoice', 1, '2026-10-20T05:00:00Z', 2_000_000_000), e('invoice', 2, '2026-10-21T05:00:00Z', 2_000_000_000)])
    expect(r.summary.invoicedPaise).toBe(4_000_000_000); expect(r.rows[1].balancePaise).toBe(4_000_000_000); expect(r.summary.outstandingPaise).toBe(4_000_000_000)
  })
  it('sorts by time, then kind order, then id, without mutating the input', () => {
    const same = '2026-10-20T05:00:00Z'
    const input = [e('refund', 1, same, 1), e('receipt', 5, same, 1), e('receipt', 3, same, 1), e('advance', 1, same, 1), e('credit_note', 1, same, 1), e('invoice', 1, same, 1), e('invoice', 0, '2026-10-19T00:00:00Z', 1)]
    const copy = [...input]
    const r = computeLedger(input)
    expect(r.rows.map((x) => `${x.kind}-${x.id}`)).toEqual(['invoice-0', 'invoice-1', 'credit_note-1', 'advance-1', 'receipt-3', 'receipt-5', 'refund-1'])
    expect(input).toEqual(copy)
  })
  it('an empty ledger is zero', () => {
    expect(computeLedger([])).toEqual({ rows: [], summary: { invoicedPaise: 0, creditedPaise: 0, receivedPaise: 0, refundedPaise: 0, balancePaise: 0, outstandingPaise: 0, creditBalancePaise: 0, insurerSettledPaise: 0, writtenOffPaise: 0 /* SP7 */ } })
  })
  it('admission deposit counts only that admission, net of refunds', () => {
    const entries = [e('advance', 1, '2026-10-20T05:00:00Z', 5000, 9), e('advance', 2, '2026-10-20T06:00:00Z', 7000, 8), e('refund', 1, '2026-10-21T05:00:00Z', 2000, 9), e('receipt', 3, '2026-10-21T06:00:00Z', 900, 9)]
    expect(admissionDepositPaise(entries, 9)).toBe(3000)
    expect(admissionDepositPaise(entries, 8)).toBe(7000)
    expect(admissionDepositPaise(entries, 7)).toBe(0)
  })
  it('admission deposit floors at zero', () => {
    expect(admissionDepositPaise([e('advance', 1, '2026-10-20T05:00:00Z', 100, 9), e('refund', 1, '2026-10-21T05:00:00Z', 500, 9)], 9)).toBe(0)
  })
})

// SP7 (ruling 5)
describe('SP7 insurer credits', () => {
  it('insurer settlements and write-offs credit the patient ledger', () => {
    const at = new Date('2099-06-01T06:00:00Z')
    const { summary, rows } = computeLedger([
      { kind: 'invoice', id: 1, number: 'INV/1', at, amountPaise: 1_00_000_00, admissionId: null },
      { kind: 'insurer_settlement', id: 2, number: 'CLM-2099-000001/S2', at, amountPaise: 80_000_00, admissionId: null },
      { kind: 'write_off', id: 3, number: 'CLM-2099-000001/W3', at, amountPaise: 5_000_00, admissionId: null },
    ])
    expect(summary).toMatchObject({ balancePaise: 15_000_00, outstandingPaise: 15_000_00, insurerSettledPaise: 80_000_00, writtenOffPaise: 5_000_00, receivedPaise: 0 })
    expect(rows.map((r) => r.kind)).toEqual(['invoice', 'insurer_settlement', 'write_off'])
  })
})
// end SP7
