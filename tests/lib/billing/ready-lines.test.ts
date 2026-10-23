import { describe, it, expect } from 'vitest'
import { groupReadyLines, type ReadyLineInput } from '@/lib/billing/ready-lines'

// WS2 T12: which captured, uninvoiced lines "Invoice all ready lines" drafts (spec ruling 12), and
// how they group (createDraftInvoice's rule: patient, payer, admission-or-encounter).
const line = (over: Partial<ReadyLineInput> & { id: number }): ReadyLineInput => ({
  patientId: 'P1', payerId: null, encounterId: null, admissionId: null, encounterType: null, encounterStatus: null, admissionStatus: null, ...over,
})
const opd = (id: number, encounterId: number, status: ReadyLineInput['encounterStatus'], over: Partial<ReadyLineInput> = {}) =>
  line({ id, encounterId, encounterType: 'opd', encounterStatus: status, ...over })

describe('groupReadyLines', () => {
  it('completed OPD lines group per encounter', () => {
    const r = groupReadyLines([opd(3, 10, 'completed'), opd(1, 10, 'completed'), opd(2, 11, 'completed'), opd(4, 10, 'completed', { patientId: 'P2' })])
    expect(r).toEqual({
      groups: [
        { patientId: 'P1', payerId: null, admissionId: null, encounterId: 10, lineIds: [1, 3] },
        { patientId: 'P1', payerId: null, admissionId: null, encounterId: 11, lineIds: [2] },
        { patientId: 'P2', payerId: null, admissionId: null, encounterId: 10, lineIds: [4] },
      ],
      waiting: [],
    })
  })

  it('lines of an open visit wait: visit_open', () => {
    expect(groupReadyLines([opd(1, 10, 'in_consultation'), opd(2, 11, 'checked_in')])).toEqual({
      groups: [], waiting: [{ lineId: 1, why: 'visit_open' }, { lineId: 2, why: 'visit_open' }],
    })
  })

  it('lines of an admitted stay wait (still_admitted); a discharged stay is one group, whatever the visit', () => {
    const r = groupReadyLines([
      line({ id: 1, admissionId: 5, admissionStatus: 'admitted', encounterId: 20, encounterType: 'ipd', encounterStatus: 'in_consultation' }),
      line({ id: 2, admissionId: 6, admissionStatus: 'discharged', encounterId: 21, encounterType: 'ipd', encounterStatus: 'in_consultation' }),
      line({ id: 3, admissionId: 6, admissionStatus: 'discharged' }),
      line({ id: 4, admissionId: 6, admissionStatus: 'discharged', encounterId: 22, encounterType: 'opd', encounterStatus: 'completed' }),
    ])
    expect(r).toEqual({
      groups: [{ patientId: 'P1', payerId: null, admissionId: 6, encounterId: null, lineIds: [2, 3, 4] }],
      waiting: [{ lineId: 1, why: 'still_admitted' }],
    })
  })

  it('a lab-type visit is ready in any open status; a cancelled visit\'s lines are neither ready nor waiting', () => {
    const r = groupReadyLines([
      line({ id: 1, encounterId: 30, encounterType: 'lab', encounterStatus: 'checked_in' }),
      line({ id: 2, encounterId: 30, encounterType: 'lab', encounterStatus: 'checked_in' }),
      opd(3, 31, 'cancelled'),
      line({ id: 4, encounterId: 32, encounterType: 'lab', encounterStatus: 'cancelled' }),
    ])
    expect(r).toEqual({ groups: [{ patientId: 'P1', payerId: null, admissionId: null, encounterId: 30, lineIds: [1, 2] }], waiting: [] })
  })

  it('pharmacy lines with no visit or stay: one group per patient and payer', () => {
    const r = groupReadyLines([line({ id: 1 }), line({ id: 2, payerId: 9 }), line({ id: 3 }), line({ id: 4, patientId: 'P2' })])
    expect(r.groups).toEqual([
      { patientId: 'P1', payerId: null, admissionId: null, encounterId: null, lineIds: [1, 3] },
      { patientId: 'P1', payerId: 9, admissionId: null, encounterId: null, lineIds: [2] },
      { patientId: 'P2', payerId: null, admissionId: null, encounterId: null, lineIds: [4] },
    ])
  })

  it('self-pay and payer lines of one stay are two groups', () => {
    const r = groupReadyLines([
      line({ id: 1, admissionId: 6, admissionStatus: 'discharged', payerId: 9 }),
      line({ id: 2, admissionId: 6, admissionStatus: 'discharged' }),
      line({ id: 3, admissionId: 6, admissionStatus: 'discharged', payerId: 9 }),
    ])
    expect(r.groups).toEqual([
      { patientId: 'P1', payerId: 9, admissionId: 6, encounterId: null, lineIds: [1, 3] },
      { patientId: 'P1', payerId: null, admissionId: 6, encounterId: null, lineIds: [2] },
    ])
  })

  it('a visit pharmacy line joins its visit\'s group', () => {
    const r = groupReadyLines([opd(1, 10, 'completed'), opd(2, 10, 'completed'), line({ id: 3, encounterId: 10, encounterType: 'opd', encounterStatus: 'completed' })])
    expect(r.groups).toEqual([{ patientId: 'P1', payerId: null, admissionId: null, encounterId: 10, lineIds: [1, 2, 3] }])
  })
})
