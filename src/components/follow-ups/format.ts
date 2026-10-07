// Pure, client-safe formatters for the follow-up screens. No Intl and no
// toLocale*: output is identical on the server and in the browser, so SSR
// hydration always agrees. Business time is Asia/Kolkata (UTC+05:30, no DST).
import type { ContactChannel, ContactOutcome } from '@/lib/follow-ups/view'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const IST_OFFSET_MS = 330 * 60_000

/** '2026-10-07' -> '7 Oct 2026'. */
export function formatIsoDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return '—'
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? '—'} ${m[1]}`
}

function istParts(instant: Date) {
  const d = new Date(instant.getTime() + IST_OFFSET_MS)
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), day: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }
}

/** The IST calendar date (YYYY-MM-DD) of an instant. */
export function istDateIso(instant: Date): string {
  const p = istParts(instant)
  return `${p.y}-${String(p.mo + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** '22 Oct 2026, 12:30 am' (IST). */
export function formatIstDateTime(instant: Date | string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant
  if (Number.isNaN(d.getTime())) return '—'
  const p = istParts(d)
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12
  return `${p.day} ${MONTHS[p.mo]} ${p.y}, ${h12}:${String(p.mi).padStart(2, '0')} ${p.h < 12 ? 'am' : 'pm'}`
}

/** Whole days from a to b (YYYY-MM-DD), UTC maths. */
export function daysBetweenIso(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

export const CHANNEL_LABEL: Record<ContactChannel, string> = {
  phone: 'Phone', sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email', in_person: 'In person',
}
export const OUTCOME_LABEL: Record<ContactOutcome, string> = {
  reached_booked: 'Reached, booked', reached_will_call_back: 'Reached, will call back', reached_declined: 'Reached, declined',
  no_answer: 'No answer', wrong_number: 'Wrong number', message_left: 'Message left',
}

export const FIELD = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
export const LABEL = 'mb-1 block text-xs font-medium text-muted-foreground'
