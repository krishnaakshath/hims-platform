import { describe, it, expect } from 'vitest'
import {
  ALL_ROLES, CLINICAL_ROLES, PATIENT_DIRECTORY_ROLES, SCHEDULING_ROLES, DOCUMENT_READ_ROLES, CHARGES_ROLES, TARIFF_LOOKUP_ROLES,
  TARIFF_MANAGE_ROLES, INSURANCE_CARD_READ_ROLES, PAYER_LOOKUP_ROLES, IDENTITY_VERIFY_ROLES, TRIAL_CRITERIA_EDIT_ROLES,
  WORKBOOK_EXPORT_ROLES, MASTER_DATA_ADMIN_ROLES, REGISTRATION_ROLES, PATIENT_PROFILE_EDIT_ROLES, AADHAAR_WRITE_ROLES,
  AADHAAR_MASKED_READ_ROLES, FOLLOW_UP_VIEW_ROLES, FOLLOW_UP_PLAN_ROLES, FOLLOW_UP_BOOKING_ROLES, FOLLOW_UP_WORKLIST_ROLES,
  FOLLOW_UP_CLINICAL_NOTES_ROLES, CHECK_IN_ROLES, ENCOUNTER_STATUS_ROLES, DISCHARGE_ROLES,
  LAB_WORKLIST_ROLES, LAB_ORDER_ROLES, LAB_COLLECT_ROLES, LAB_RECEIVE_ROLES, LAB_RESULT_ENTRY_ROLES, LAB_VERIFY_ROLES,
  LAB_REPORT_RELEASE_ROLES, LAB_REPORT_READ_ROLES, LAB_LABEL_ROLES, LAB_SETUP_ROLES, HOME_COLLECTION_BOOKING_ROLES,
  HOME_COLLECTION_CANCEL_ROLES, HOME_COLLECTION_DISPATCH_ROLES, COLLECTOR_ROUTE_ROLES, NOTIFICATION_PREFERENCE_ROLES,
  searchScopesFor, hasSearchScope,
} from '@/lib/role-policy'

describe('SP5 role policy', () => {
  it('every SP5 allowlist is exactly as specified', () => {
    expect(LAB_WORKLIST_ROLES).toEqual(['admin', 'pi', 'crc', 'labs'])
    expect(LAB_ORDER_ROLES).toEqual(['admin', 'pi'])
    expect(LAB_COLLECT_ROLES).toEqual(['admin', 'pi', 'labs'])
    expect(LAB_RECEIVE_ROLES).toEqual(['admin', 'labs'])
    expect(LAB_RESULT_ENTRY_ROLES).toEqual(['admin', 'labs'])
    expect(LAB_VERIFY_ROLES).toEqual(['admin', 'pi'])
    expect(LAB_REPORT_RELEASE_ROLES).toEqual(['admin', 'pi', 'labs'])
    expect(LAB_REPORT_READ_ROLES).toEqual(['admin', 'pi', 'crc', 'labs'])
    expect(LAB_LABEL_ROLES).toEqual(['admin', 'pi', 'labs', 'frontdesk'])
    expect(LAB_SETUP_ROLES).toEqual(['admin'])
    expect(HOME_COLLECTION_BOOKING_ROLES).toEqual(['admin', 'frontdesk', 'labs'])
    expect(HOME_COLLECTION_CANCEL_ROLES).toEqual(['admin', 'frontdesk', 'labs', 'collector'])
    expect(HOME_COLLECTION_DISPATCH_ROLES).toEqual(['admin', 'labs'])
    expect(COLLECTOR_ROUTE_ROLES).toEqual(['admin', 'collector'])
    expect(NOTIFICATION_PREFERENCE_ROLES).toEqual(['admin', 'crc', 'frontdesk'])
  })

  it('collector is only in the two SP5 lists that name it', () => {
    const sp5 = {
      LAB_WORKLIST_ROLES, LAB_ORDER_ROLES, LAB_COLLECT_ROLES, LAB_RECEIVE_ROLES, LAB_RESULT_ENTRY_ROLES, LAB_VERIFY_ROLES,
      LAB_REPORT_RELEASE_ROLES, LAB_REPORT_READ_ROLES, LAB_LABEL_ROLES, LAB_SETUP_ROLES, HOME_COLLECTION_BOOKING_ROLES,
      HOME_COLLECTION_CANCEL_ROLES, HOME_COLLECTION_DISPATCH_ROLES, COLLECTOR_ROUTE_ROLES, NOTIFICATION_PREFERENCE_ROLES,
    }
    const withCollector = Object.entries(sp5).filter(([, roles]) => roles.includes('collector')).map(([name]) => name)
    expect(withCollector).toEqual(['HOME_COLLECTION_CANCEL_ROLES', 'COLLECTOR_ROUTE_ROLES'])
  })

  it('collector is in ALL_ROLES and in no pre-SP5 allowlist', () => {
    expect(ALL_ROLES).toContain('collector')
    for (const list of [
      CLINICAL_ROLES, PATIENT_DIRECTORY_ROLES, SCHEDULING_ROLES, DOCUMENT_READ_ROLES, CHARGES_ROLES, TARIFF_LOOKUP_ROLES,
      TARIFF_MANAGE_ROLES, INSURANCE_CARD_READ_ROLES, PAYER_LOOKUP_ROLES, IDENTITY_VERIFY_ROLES, TRIAL_CRITERIA_EDIT_ROLES,
      WORKBOOK_EXPORT_ROLES, MASTER_DATA_ADMIN_ROLES, REGISTRATION_ROLES, PATIENT_PROFILE_EDIT_ROLES, AADHAAR_WRITE_ROLES,
      AADHAAR_MASKED_READ_ROLES, FOLLOW_UP_VIEW_ROLES, FOLLOW_UP_PLAN_ROLES, FOLLOW_UP_BOOKING_ROLES, FOLLOW_UP_WORKLIST_ROLES,
      FOLLOW_UP_CLINICAL_NOTES_ROLES, CHECK_IN_ROLES, ENCOUNTER_STATUS_ROLES, DISCHARGE_ROLES,
    ]) expect(list).not.toContain('collector')
  })

  it('collector gets no global search scope', () => {
    expect(searchScopesFor('collector')).toEqual({ patients: false, trials: false, formTemplates: false })
    expect(hasSearchScope('collector')).toBe(false)
  })
})
