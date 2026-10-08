import { NextResponse } from 'next/server'
import type { ZodError } from 'zod'
import { offsetDateTimeSchema } from '@/lib/follow-ups/validation'

// Wave A (P0-03): an appointment instant must carry an explicit UTC offset
// ("2026-11-03T09:00:00+05:30" or "...Z"). A naive "2026-11-03T09:00:00" is
// parsed in the server's own zone (UTC on Vercel), silently moving a 09:00 IST
// booking to 14:30 IST. Every appointment-writing route uses this schema and
// the same fixed 400 as the SP3 follow-up booking route.
export const appointmentInstantSchema = offsetDateTimeSchema

export const INVALID_APPOINTMENT_TIME =
  'Invalid appointment time. Send start/end times with a UTC offset (e.g. +05:30), ending after the start.'

/** True when a zod failure involves one of the time fields (so the caller answers with the fixed time 400). */
export function isTimeFieldError(error: ZodError, fields: readonly string[] = ['startsAt', 'endsAt']): boolean {
  return error.issues.some((i) => fields.includes(String(i.path[0])))
}

export function invalidAppointmentTime(): NextResponse {
  return NextResponse.json({ error: INVALID_APPOINTMENT_TIME }, { status: 400 })
}
