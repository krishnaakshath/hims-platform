// SP5 patient notification templates (pure, client-safe). PHI rule: a text carries the
// hospital name, dates and window labels only -- never the patient's name, test names,
// results, Aadhaar or ABHA. Dates are YYYY-MM-DD business (IST) dates, shown with formatIsoDate.
import { formatIsoDate } from '@/lib/india-time'

export const NOTIFICATION_TEMPLATE_KEYS = [
  'lab_tests_ordered',
  'home_collection_booked',
  'home_collection_rescheduled',
  'home_collection_cancelled',
  'lab_report_ready',
  // Foundations T8
  'form_sent',
  'video_visit_link',
  'booking_confirmed',
  'appointment_reminder',
] as const
export type NotificationTemplateKey = (typeof NOTIFICATION_TEMPLATE_KEYS)[number]

export interface TemplateVars {
  lab_tests_ordered: { hospitalName: string }
  home_collection_booked: { hospitalName: string; visitDate: string; windowLabel: string }
  home_collection_rescheduled: { hospitalName: string; visitDate: string; windowLabel: string }
  home_collection_cancelled: { hospitalName: string; visitDate: string }
  lab_report_ready: { hospitalName: string }
  // Foundations T8: links stay generic ("sign in to the patient portal"); no token or URL is ever a var.
  form_sent: { hospitalName: string }
  video_visit_link: { hospitalName: string; visitDate: string; timeLabel: string }
  booking_confirmed: { hospitalName: string; visitDate: string; timeLabel: string }
  appointment_reminder: { hospitalName: string; visitDate: string; timeLabel: string }
}

const TEMPLATES: { [K in NotificationTemplateKey]: (v: TemplateVars[K]) => string } = {
  lab_tests_ordered: ({ hospitalName: h }) =>
    `${h}: Your doctor has ordered lab tests. We can collect your samples at home. Please contact the hospital to book a collection slot.`,
  home_collection_booked: ({ hospitalName: h, visitDate, windowLabel }) =>
    `${h}: Home sample collection booked for ${formatIsoDate(visitDate)}, ${windowLabel}. Our collector will call before arriving.`,
  home_collection_rescheduled: ({ hospitalName: h, visitDate, windowLabel }) =>
    `${h}: Your home sample collection has moved to ${formatIsoDate(visitDate)}, ${windowLabel}.`,
  home_collection_cancelled: ({ hospitalName: h, visitDate }) =>
    `${h}: Your home sample collection on ${formatIsoDate(visitDate)} has been cancelled. Please contact the hospital to rebook.`,
  lab_report_ready: ({ hospitalName: h }) =>
    `${h}: Your lab report is ready. Sign in to the patient portal to view and download it.`,
  form_sent: ({ hospitalName: h }) =>
    `${h}: You have a form to fill in. Sign in to the patient portal to complete it.`,
  video_visit_link: ({ hospitalName: h, visitDate, timeLabel }) =>
    `${h}: Your video consultation is on ${formatIsoDate(visitDate)}, ${timeLabel}. Sign in to the patient portal to join.`,
  booking_confirmed: ({ hospitalName: h, visitDate, timeLabel }) =>
    `${h}: Your appointment is confirmed for ${formatIsoDate(visitDate)}, ${timeLabel}. Sign in to the patient portal for details.`,
  appointment_reminder: ({ hospitalName: h, visitDate, timeLabel }) =>
    `${h}: Reminder: your appointment is on ${formatIsoDate(visitDate)}, ${timeLabel}. Sign in to the patient portal for details.`,
}

export function renderNotification<K extends NotificationTemplateKey>(key: K, vars: TemplateVars[K]): string {
  return TEMPLATES[key](vars)
}

// Foundations T8: ordered body parameters for provider-side templates (WhatsApp, DLT). Only the
// declared vars, in this order, ever leave the app; extra keys a caller passes are dropped.
const PARAM_KEYS: { [K in NotificationTemplateKey]: readonly (keyof TemplateVars[K])[] } = {
  lab_tests_ordered: ['hospitalName'],
  home_collection_booked: ['hospitalName', 'visitDate', 'windowLabel'],
  home_collection_rescheduled: ['hospitalName', 'visitDate', 'windowLabel'],
  home_collection_cancelled: ['hospitalName', 'visitDate'],
  lab_report_ready: ['hospitalName'],
  form_sent: ['hospitalName'],
  video_visit_link: ['hospitalName', 'visitDate', 'timeLabel'],
  booking_confirmed: ['hospitalName', 'visitDate', 'timeLabel'],
  appointment_reminder: ['hospitalName', 'visitDate', 'timeLabel'],
}

export function templateParams<K extends NotificationTemplateKey>(key: K, vars: TemplateVars[K]): string[] {
  return (PARAM_KEYS[key] as readonly string[]).map((k) => {
    const v = String((vars as Record<string, unknown>)[k] ?? '')
    return k === 'visitDate' ? formatIsoDate(v) : v
  })
}

const SUBJECTS: { [K in NotificationTemplateKey]: string } = {
  lab_tests_ordered: 'Lab tests ordered',
  home_collection_booked: 'Home sample collection booked',
  home_collection_rescheduled: 'Home sample collection moved',
  home_collection_cancelled: 'Home sample collection cancelled',
  lab_report_ready: 'Your lab report is ready',
  form_sent: 'A form to fill in',
  video_visit_link: 'Your video consultation',
  booking_confirmed: 'Appointment confirmed',
  appointment_reminder: 'Appointment reminder',
}

/** Email subject: hospital name plus a fixed, PHI-free phrase. */
export function notificationSubject(key: NotificationTemplateKey, hospitalName: string): string {
  return `${hospitalName}: ${SUBJECTS[key]}`
}
// end Foundations T8
