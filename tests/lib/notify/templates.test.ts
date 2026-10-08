import { describe, it, expect } from 'vitest'
import { NOTIFICATION_TEMPLATE_KEYS, renderNotification } from '@/lib/notify/templates'

describe('notification templates', () => {
  it('has exactly the five SP5 templates', () => {
    expect(NOTIFICATION_TEMPLATE_KEYS).toEqual(['lab_tests_ordered', 'home_collection_booked', 'home_collection_rescheduled', 'home_collection_cancelled', 'lab_report_ready'])
  })

  it('renders exact copy with IST dates and no personal data', () => {
    expect(renderNotification('home_collection_booked', { hospitalName: 'City Hospital', visitDate: '2026-10-21', windowLabel: 'Morning 09:00–11:00' }))
      .toBe('City Hospital: Home sample collection booked for 21 Oct 2026, Morning 09:00–11:00. Our collector will call before arriving.')
    expect(renderNotification('lab_tests_ordered', { hospitalName: 'City Hospital' }))
      .toBe('City Hospital: Your doctor has ordered lab tests. We can collect your samples at home. Please contact the hospital to book a collection slot.')
    expect(renderNotification('home_collection_rescheduled', { hospitalName: 'City Hospital', visitDate: '2026-11-01', windowLabel: 'Early 07:00–09:00' }))
      .toBe('City Hospital: Your home sample collection has moved to 1 Nov 2026, Early 07:00–09:00.')
    expect(renderNotification('home_collection_cancelled', { hospitalName: 'City Hospital', visitDate: '2026-12-31' }))
      .toBe('City Hospital: Your home sample collection on 31 Dec 2026 has been cancelled. Please contact the hospital to rebook.')
    expect(renderNotification('lab_report_ready', { hospitalName: 'City Hospital' }))
      .toBe('City Hospital: Your lab report is ready. Sign in to the patient portal to view and download it.')
  })

  it('uses the calendar date as given (no timezone shift at the year boundary)', () => {
    expect(renderNotification('home_collection_cancelled', { hospitalName: 'H', visitDate: '2027-01-01' })).toContain('1 Jan 2027')
  })
})
