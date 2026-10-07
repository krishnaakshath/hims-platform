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
