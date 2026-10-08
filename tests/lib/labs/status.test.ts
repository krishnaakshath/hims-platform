import { describe, it, expect } from 'vitest'
import {
  LAB_ORDER_STATUSES, LAB_TRANSITIONS, canTransitionLabOrder, PRE_RESULT_STATUSES, RESULT_EDITABLE_STATUSES,
  LAB_STATUS_LABEL, fhirObservationStatusFor, LIS_ACCEPTED_OBSERVATION_STATUSES, isAcceptedLisObservationStatus,
} from '@/lib/labs/status'

describe('lab order status machine', () => {
  it('lists the statuses in lifecycle order', () => {
    expect(LAB_ORDER_STATUSES).toEqual(['ordered', 'scheduled', 'collected', 'received', 'resulted', 'verified', 'reported', 'cancelled'])
  })

  it('allows exactly the documented transitions', () => {
    expect(canTransitionLabOrder('ordered', 'scheduled')).toBe(true)
    expect(canTransitionLabOrder('scheduled', 'ordered')).toBe(true)
    expect(canTransitionLabOrder('collected', 'resulted')).toBe(false)
    expect(canTransitionLabOrder('resulted', 'cancelled')).toBe(false)
    expect(canTransitionLabOrder('verified', 'reported')).toBe(true)
    expect(LAB_TRANSITIONS.reported).toEqual([])
    expect(LAB_TRANSITIONS.cancelled).toEqual([])
  })

  it('matches the full transition table', () => {
    expect(LAB_TRANSITIONS).toEqual({
      ordered: ['scheduled', 'collected', 'cancelled'],
      scheduled: ['ordered', 'collected', 'cancelled'],
      collected: ['received', 'cancelled'],
      received: ['resulted', 'cancelled'],
      resulted: ['verified'],
      verified: ['reported'],
      reported: [],
      cancelled: [],
    })
    // exhaustive: every pair not in the table is refused
    for (const from of LAB_ORDER_STATUSES) {
      for (const to of LAB_ORDER_STATUSES) {
        expect(canTransitionLabOrder(from, to)).toBe(LAB_TRANSITIONS[from].includes(to))
      }
    }
  })

  it('the pre-result set is exactly the cancellable set', () => {
    expect(PRE_RESULT_STATUSES).toEqual(['ordered', 'scheduled', 'collected', 'received'])
    for (const s of LAB_ORDER_STATUSES) {
      expect(canTransitionLabOrder(s, 'cancelled')).toBe((PRE_RESULT_STATUSES as readonly string[]).includes(s))
    }
    expect(RESULT_EDITABLE_STATUSES).toEqual(['received', 'resulted'])
  })

  it('labels every status', () => {
    expect(LAB_STATUS_LABEL.scheduled).toBe('Home collection booked')
    expect(LAB_STATUS_LABEL.resulted).toBe('Awaiting verification')
    expect(Object.keys(LAB_STATUS_LABEL).sort()).toEqual([...LAB_ORDER_STATUSES].sort())
  })

  it('maps statuses to FHIR observation status', () => {
    expect(fhirObservationStatusFor('resulted')).toBe('preliminary')
    expect(fhirObservationStatusFor('verified')).toBe('final')
    expect(fhirObservationStatusFor('reported')).toBe('final')
    expect(fhirObservationStatusFor('received')).toBeNull()
    expect(fhirObservationStatusFor('cancelled')).toBeNull()
    expect(isAcceptedLisObservationStatus('cancelled')).toBe(false)
    expect(isAcceptedLisObservationStatus('final')).toBe(true)
    expect(LIS_ACCEPTED_OBSERVATION_STATUSES).toEqual(['preliminary', 'final', 'amended', 'corrected'])
  })
})
