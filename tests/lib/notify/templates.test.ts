import { describe, it, expect } from 'vitest'
import { NOTIFICATION_TEMPLATE_KEYS, renderNotification, templateParams, templateVarsValid } from '@/lib/notify/templates'

describe('notification templates', () => {
  it('has the five SP5 templates, the four Foundations T8 templates and the WS7 T10 broadcast notice', () => {
    expect(NOTIFICATION_TEMPLATE_KEYS).toEqual([
      'lab_tests_ordered', 'home_collection_booked', 'home_collection_rescheduled', 'home_collection_cancelled', 'lab_report_ready',
      'form_sent', 'video_visit_link', 'booking_confirmed', 'appointment_reminder',
      'broadcast_notice',
    ])
  })

  // WS7 T10
  it('broadcast_notice is the hospital name plus the staff message, which must be 1–140 characters', () => {
    expect(renderNotification('broadcast_notice', { hospitalName: 'City Hospital', message: 'Free eye camp on Sunday.' })).toBe('City Hospital: Free eye camp on Sunday.')
    expect(templateParams('broadcast_notice', { hospitalName: 'H', message: 'Hi' })).toEqual(['H', 'Hi'])
    expect(templateVarsValid('broadcast_notice', { hospitalName: 'H', message: 'x'.repeat(140) })).toBe(true)
    expect(templateVarsValid('broadcast_notice', { hospitalName: 'H', message: 'x'.repeat(141) })).toBe(false)
    expect(templateVarsValid('broadcast_notice', { hospitalName: 'H', message: ' ' })).toBe(false)
  })

  // Foundations T8
  it('renders the T8 templates with generic portal wording (no links, no tokens)', () => {
    expect(renderNotification('form_sent', { hospitalName: 'City Hospital' }))
      .toBe('City Hospital: You have a form to fill in. Sign in to the patient portal to complete it.')
    expect(renderNotification('video_visit_link', { hospitalName: 'City Hospital', visitDate: '2026-10-21', timeLabel: '10:30' }))
      .toBe('City Hospital: Your video consultation is on 21 Oct 2026, 10:30. Sign in to the patient portal to join.')
    expect(renderNotification('booking_confirmed', { hospitalName: 'City Hospital', visitDate: '2026-10-21', timeLabel: '10:30' }))
      .toBe('City Hospital: Your appointment is confirmed for 21 Oct 2026, 10:30. Sign in to the patient portal for details.')
    expect(renderNotification('appointment_reminder', { hospitalName: 'City Hospital', visitDate: '2026-10-21', timeLabel: '10:30' }))
      .toBe('City Hospital: Reminder: your appointment is on 21 Oct 2026, 10:30. Sign in to the patient portal for details.')
  })

  it('PHI rule: extra vars (patient name, test names, results, tokens) never reach the text or the template params', () => {
    const leaky = { hospitalName: 'H', visitDate: '2026-10-21', windowLabel: 'Morning', timeLabel: '10:30', patientName: 'Ravi Kumar', testName: 'HbA1c', result: '9.1%', token: 'tok_abc123', url: 'https://x/t/abc' }
    for (const key of NOTIFICATION_TEMPLATE_KEYS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = renderNotification(key, leaky as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params = templateParams(key, leaky as any)
      for (const bad of ['Ravi', 'HbA1c', '9.1', 'tok_abc123', 'https://', 'http://']) {
        expect(text, `${key} text`).not.toContain(bad)
        expect(params.join('|'), `${key} params`).not.toContain(bad)
      }
    }
  })

  it('template params are the declared vars in order, dates formatted', () => {
    expect(templateParams('home_collection_booked', { hospitalName: 'H', visitDate: '2026-10-21', windowLabel: 'Morning' })).toEqual(['H', '21 Oct 2026', 'Morning'])
    expect(templateParams('form_sent', { hospitalName: 'H' })).toEqual(['H'])
  })
  // end Foundations T8

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
