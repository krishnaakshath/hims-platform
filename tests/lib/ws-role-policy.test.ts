// WS1/WS2 (doctor workspace + automatic billing) role allowlists, pinned exactly as the plan states.
// BILL_SUMMARY_ROLES is not added (lane ruling R2: the discharge dues gate was dropped).
import { describe, it, expect } from 'vitest'
import * as policy from '@/lib/role-policy'
import {
  WORKSPACE_READ_ROLES, CLINICAL_WRITE_ROLES, VITALS_ROLES, ALLERGY_WRITE_ROLES, PRESCRIBE_ROLES,
  MEDICATION_SEARCH_ROLES, DISPENSE_ROLES, MEDICATION_PRICE_ROLES, INVOICE_READY_ROLES, CHARGE_CAPTURE_ROLES,
  HOME_COLLECTION_BOOKING_ROLES,
} from '@/lib/role-policy'

describe('WS1/WS2 role policy', () => {
  it('every new allowlist is exactly as specified', () => {
    expect(WORKSPACE_READ_ROLES).toEqual(['admin', 'pi', 'crc'])
    expect(CLINICAL_WRITE_ROLES).toEqual(['admin', 'pi'])
    expect(VITALS_ROLES).toEqual(['admin', 'pi', 'crc'])
    expect(ALLERGY_WRITE_ROLES).toEqual(['admin', 'pi', 'crc'])
    expect(PRESCRIBE_ROLES).toEqual(['admin', 'pi'])
    expect(MEDICATION_SEARCH_ROLES).toEqual(['admin', 'pi', 'pharmacy'])
    expect(DISPENSE_ROLES).toEqual(['admin', 'pi', 'pharmacy'])
    expect(MEDICATION_PRICE_ROLES).toEqual(['admin', 'pharmacy'])
    expect(INVOICE_READY_ROLES).toEqual(CHARGE_CAPTURE_ROLES)
  })

  it('a doctor can book a home collection', () => {
    expect(HOME_COLLECTION_BOOKING_ROLES).toContain('pi')
  })

  it('has no BILL_SUMMARY_ROLES (ruling R2)', () => {
    expect('BILL_SUMMARY_ROLES' in policy).toBe(false)
  })
})
