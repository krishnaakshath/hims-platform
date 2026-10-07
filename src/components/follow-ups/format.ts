// Pure, client-safe formatters for the follow-up screens. No Intl and no
// toLocale*: output is identical on the server and in the browser, so SSR
// hydration always agrees. Business time is Asia/Kolkata (UTC+05:30, no DST).
import type { ContactChannel, ContactOutcome } from '@/lib/follow-ups/view'
import { formatIstDateTime as formatIstDateTimeShared } from '@/lib/india-time'

// The shared, pure IST formatters (src/lib/india-time.ts) -- one implementation.
export { formatCalendarDate as formatIsoDate, istDateOf as istDateIso } from '@/lib/india-time'

/** '22 Oct 2026, 12:30 am' (IST). */
export function formatIstDateTime(instant: Date | string): string {
  return formatIstDateTimeShared(instant)
}

/** Whole days from a to b (YYYY-MM-DD): the one shared rule. */
export { daysBetweenIso } from '@/lib/follow-ups/rules'

export const CHANNEL_LABEL: Record<ContactChannel, string> = {
  phone: 'Phone', sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email', in_person: 'In person',
}
export const OUTCOME_LABEL: Record<ContactOutcome, string> = {
  reached_booked: 'Reached, booked', reached_will_call_back: 'Reached, will call back', reached_declined: 'Reached, declined',
  no_answer: 'No answer', wrong_number: 'Wrong number', message_left: 'Message left',
}

export const FIELD = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
export const LABEL = 'mb-1 block text-xs font-medium text-muted-foreground'
