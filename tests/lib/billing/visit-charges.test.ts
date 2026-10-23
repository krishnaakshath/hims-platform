import { describe, it, expect } from 'vitest'
import { autoBillTo, planVisitCharges } from '@/lib/billing/visit-charges'

// WS2 T9: which visit charges a check-in (or completion) captures.
const base = {
  encounterType: 'opd' as const, visitType: 'new' as const, encounterDate: '2099-06-10', departmentId: 3,
  hasLiveRegistrationLine: false, priorEncounterCount: 0, lastChargedConsultDate: null, freeReviewDays: 0,
}

describe('planVisitCharges', () => {
  it('first OPD visit: registration and consultation', () => {
    expect(planVisitCharges(base)).toEqual({ registration: true, consultation: true, consultationSkip: null })
  })

  it('second visit: consultation only', () => {
    expect(planVisitCharges({ ...base, priorEncounterCount: 1, hasLiveRegistrationLine: true })).toEqual({ registration: false, consultation: true, consultationSkip: null })
    // A live registration line alone (e.g. the earlier visit's line) also suppresses it.
    expect(planVisitCharges({ ...base, hasLiveRegistrationLine: true }).registration).toBe(false)
    // Prior visits with no registration line (legacy patients) are not charged registration either.
    expect(planVisitCharges({ ...base, priorEncounterCount: 3 }).registration).toBe(false)
  })

  it('follow-up within free_review_days of the last charged consultation: no consultation', () => {
    const fu = { ...base, visitType: 'follow_up' as const, priorEncounterCount: 1, hasLiveRegistrationLine: true, freeReviewDays: 7 }
    expect(planVisitCharges({ ...fu, lastChargedConsultDate: '2099-06-03' })).toEqual({ registration: false, consultation: false, consultationSkip: 'free_review' })
    expect(planVisitCharges({ ...fu, visitType: 'review', lastChargedConsultDate: '2099-06-05' }).consultationSkip).toBe('free_review')
    // Day 8 is charged again.
    expect(planVisitCharges({ ...fu, lastChargedConsultDate: '2099-06-02' })).toMatchObject({ consultation: true, consultationSkip: null })
    // A new or emergency visit is always charged.
    expect(planVisitCharges({ ...fu, visitType: 'new', lastChargedConsultDate: '2099-06-09' }).consultation).toBe(true)
    expect(planVisitCharges({ ...fu, visitType: 'emergency', lastChargedConsultDate: '2099-06-09' }).consultation).toBe(true)
    // free_review_days 0 = always charge; no prior charged consultation = charge.
    expect(planVisitCharges({ ...fu, freeReviewDays: 0, lastChargedConsultDate: '2099-06-09' }).consultation).toBe(true)
    expect(planVisitCharges({ ...fu, lastChargedConsultDate: null }).consultation).toBe(true)
  })

  it('ipd: none', () => {
    expect(planVisitCharges({ ...base, encounterType: 'ipd' })).toEqual({ registration: false, consultation: false, consultationSkip: 'ipd' })
  })

  it('lab: none', () => {
    expect(planVisitCharges({ ...base, encounterType: 'lab' })).toEqual({ registration: false, consultation: false, consultationSkip: 'lab' })
  })

  it('no department: registration still due, consultation skipped as no_department', () => {
    expect(planVisitCharges({ ...base, departmentId: null })).toEqual({ registration: true, consultation: false, consultationSkip: 'no_department' })
  })
})

describe('autoBillTo', () => {
  it('OPD is self-pay even with a primary payer; an admission bills the payer when one is set', () => {
    expect(autoBillTo({ admissionId: null, primaryPayerId: 4, isInpatient: false })).toBe('self')
    expect(autoBillTo({ admissionId: 9, primaryPayerId: 4, isInpatient: true })).toBe('payer')
    expect(autoBillTo({ admissionId: 9, primaryPayerId: null, isInpatient: true })).toBe('self')
  })
})
