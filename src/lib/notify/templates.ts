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
] as const
export type NotificationTemplateKey = (typeof NOTIFICATION_TEMPLATE_KEYS)[number]

export interface TemplateVars {
  lab_tests_ordered: { hospitalName: string }
  home_collection_booked: { hospitalName: string; visitDate: string; windowLabel: string }
  home_collection_rescheduled: { hospitalName: string; visitDate: string; windowLabel: string }
  home_collection_cancelled: { hospitalName: string; visitDate: string }
  lab_report_ready: { hospitalName: string }
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
}

export function renderNotification<K extends NotificationTemplateKey>(key: K, vars: TemplateVars[K]): string {
  return TEMPLATES[key](vars)
}
