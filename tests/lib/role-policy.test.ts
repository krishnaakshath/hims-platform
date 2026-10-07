import { describe, it, expect } from 'vitest'
import {
  FOLLOW_UP_VIEW_ROLES, FOLLOW_UP_PLAN_ROLES, FOLLOW_UP_BOOKING_ROLES, FOLLOW_UP_WORKLIST_ROLES,
  FOLLOW_UP_CLINICAL_NOTES_ROLES, CHECK_IN_ROLES, ENCOUNTER_STATUS_ROLES, DISCHARGE_ROLES, CLINICAL_ROLES,
} from '@/lib/role-policy'

describe('SP3 role allowlists', () => {
  const s = (r: readonly string[]) => [...r].sort()
  it('match the plan RBAC table', () => {
    expect(s(FOLLOW_UP_VIEW_ROLES)).toEqual(['admin', 'crc', 'frontdesk', 'pi'])
    expect(s(FOLLOW_UP_PLAN_ROLES)).toEqual(['admin', 'pi'])
    expect(s(FOLLOW_UP_BOOKING_ROLES)).toEqual(['admin', 'frontdesk'])
    expect(s(FOLLOW_UP_WORKLIST_ROLES)).toEqual(['admin', 'crc', 'frontdesk'])
    expect(s(FOLLOW_UP_CLINICAL_NOTES_ROLES)).toEqual(s(CLINICAL_ROLES))
    expect(s(CHECK_IN_ROLES)).toEqual(['admin', 'crc', 'frontdesk'])
    expect(s(ENCOUNTER_STATUS_ROLES)).toEqual(['admin', 'crc', 'frontdesk', 'pi'])
    expect(s(DISCHARGE_ROLES)).toEqual(['admin', 'pi'])
  })
})

import { searchScopesFor } from '@/lib/role-policy'

// Wave B P1-24: search per role. Patients only for PATIENT_DIRECTORY_ROLES;
// the tariff catalogue for TARIFF_MANAGE_ROLES; pharmacy and labs have no
// global search (their worklists/lookups are their search).
describe('searchScopesFor', () => {
  it('matches the Wave B decision table', () => {
    expect(searchScopesFor('admin')).toEqual({ patients: true, trials: true, formTemplates: true, services: true })
    expect(searchScopesFor('crc')).toEqual({ patients: true, trials: true, formTemplates: true, services: false })
    expect(searchScopesFor('pi')).toEqual({ patients: true, trials: true, formTemplates: true, services: false })
    expect(searchScopesFor('frontdesk')).toEqual({ patients: true, trials: false, formTemplates: false, services: false })
    expect(searchScopesFor('billing')).toEqual({ patients: false, trials: false, formTemplates: false, services: true })
    expect(searchScopesFor('pharmacy')).toEqual({ patients: false, trials: false, formTemplates: false, services: false })
    expect(searchScopesFor('labs')).toEqual({ patients: false, trials: false, formTemplates: false, services: false })
  })
})

// SP4
import {
  CHARGE_CAPTURE_ROLES, BILLING_AUTHORITY_ROLES, CASH_DESK_ROLES, BILLING_CONFIG_ROLES,
  CHARGES_ROLES, MASTER_DATA_ADMIN_ROLES,
} from '@/lib/role-policy'

describe('SP4 billing role allowlists', () => {
  it('role constants match the plan', () => {
    expect(CHARGE_CAPTURE_ROLES).toEqual(CHARGES_ROLES)
    expect([...CHARGE_CAPTURE_ROLES].sort()).toEqual(['admin', 'billing', 'crc'])
    expect([...BILLING_AUTHORITY_ROLES].sort()).toEqual(['admin', 'billing'])
    expect([...CASH_DESK_ROLES].sort()).toEqual(['admin', 'billing', 'crc', 'frontdesk'])
    expect(BILLING_CONFIG_ROLES).toEqual(MASTER_DATA_ADMIN_ROLES)
    expect([...BILLING_CONFIG_ROLES]).toEqual(['admin'])
  })

  it('frontdesk takes money but never holds billing authority or config', () => {
    expect(CASH_DESK_ROLES).toContain('frontdesk')
    expect(CHARGE_CAPTURE_ROLES).not.toContain('frontdesk')
    expect(BILLING_AUTHORITY_ROLES).not.toContain('frontdesk')
    expect(BILLING_AUTHORITY_ROLES).not.toContain('crc')
    expect(BILLING_CONFIG_ROLES).not.toContain('billing')
  })
})
// end SP4
