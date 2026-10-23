// WS6 T6: doctor working hours, slot length and leave (spec D5). The weekly template and leave
// are read here; slots themselves are computed by src/lib/scheduling/slots.ts.
import { and, asc, eq, gt, gte, lt, ne } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { appointments, providerLeave, providerSchedules, providers } from '@/db/schema'
import { istDateOf, startOfIstDay } from '@/lib/india-time'
import { invalidateCache, providersListCacheKey } from '@/lib/cache'
import { istWeekdayOf, withinWorkingHours, type Weekday, type WeeklySession } from '@/lib/scheduling/slots'

const DAY_MS = 24 * 60 * 60 * 1000

export interface ProviderSchedule {
  slotMinutes: number
  opdRoom: string | null
  sessions: WeeklySession[]
  leave: { date: string; reason: string }[]
}

export interface ProviderScheduleForDate {
  slotMinutes: number
  /** The sessions of the date's weekday only, in time order. */
  sessions: WeeklySession[]
  onLeave: boolean
}

export interface ProviderScheduleInput {
  slotMinutes: number
  sessions: WeeklySession[]
  leave: { date: string; reason: string }[]
}

/** Postgres `time` comes back as HH:MM:SS; sessions are HH:MM. */
const hhmm = (t: string) => t.slice(0, 5)

function toSession(r: { weekday: number; startTime: string; endTime: string }): WeeklySession {
  return { weekday: r.weekday as Weekday, start: hhmm(r.startTime), end: hhmm(r.endTime) }
}

/** The full weekly template and leave from `fromDateIso` onwards (IST today for the editor); null for an unknown provider. */
export async function getProviderSchedule(providerId: number, fromDateIso: string): Promise<ProviderSchedule | null> {
  const db = getDb()
  const [p] = await db.select({ slotMinutes: providers.slotMinutes, opdRoom: providers.opdRoom }).from(providers).where(eq(providers.id, providerId))
  if (!p) return null
  const [sessions, leave] = await Promise.all([
    db.select({ weekday: providerSchedules.weekday, startTime: providerSchedules.startTime, endTime: providerSchedules.endTime })
      .from(providerSchedules).where(eq(providerSchedules.providerId, providerId))
      .orderBy(asc(providerSchedules.weekday), asc(providerSchedules.startTime)),
    db.select({ date: providerLeave.leaveDate, reason: providerLeave.reason })
      .from(providerLeave).where(and(eq(providerLeave.providerId, providerId), gte(providerLeave.leaveDate, fromDateIso)))
      .orderBy(asc(providerLeave.leaveDate)),
  ])
  return { slotMinutes: p.slotMinutes, opdRoom: p.opdRoom, sessions: sessions.map(toSession), leave }
}

/**
 * A doctor's slot length, the sessions of the IST weekday of `dateIso` and whether that day is a
 * leave day; null for an unknown provider. Shared by the slots route, the booking working-hours
 * check and the front-desk queue summary.
 */
export async function getProviderScheduleForDate(providerId: number, dateIso: string): Promise<ProviderScheduleForDate | null> {
  const db = getDb()
  const [p] = await db.select({ slotMinutes: providers.slotMinutes }).from(providers).where(eq(providers.id, providerId))
  if (!p) return null
  const [sessions, leave] = await Promise.all([
    db.select({ weekday: providerSchedules.weekday, startTime: providerSchedules.startTime, endTime: providerSchedules.endTime })
      .from(providerSchedules)
      .where(and(eq(providerSchedules.providerId, providerId), eq(providerSchedules.weekday, istWeekdayOf(dateIso))))
      .orderBy(asc(providerSchedules.startTime)),
    db.select({ id: providerLeave.id }).from(providerLeave)
      .where(and(eq(providerLeave.providerId, providerId), eq(providerLeave.leaveDate, dateIso))).limit(1),
  ])
  return { slotMinutes: p.slotMinutes, sessions: sessions.map(toSession), onLeave: leave.length > 0 }
}

/** WS6 T7: whether the doctor has any weekly session at all (working hours have been set up). */
export async function hasWorkingHours(providerId: number): Promise<boolean> {
  const [row] = await getDb().select({ id: providerSchedules.id }).from(providerSchedules)
    .where(eq(providerSchedules.providerId, providerId)).limit(1)
  return row !== undefined
}

/**
 * WS6 T7: true when [startsAt, endsAt) is not inside one of the doctor's sessions on its IST date,
 * or that date is a leave day. A doctor with no weekly sessions at all has no hours set up yet and
 * is never outside them (legacy doctors keep booking until hours are entered); so is an unknown id.
 */
export async function isOutsideWorkingHours(providerId: number, startsAt: Date, endsAt: Date): Promise<boolean> {
  if (!(await hasWorkingHours(providerId))) return false
  const schedule = await getProviderScheduleForDate(providerId, istDateOf(startsAt))
  if (!schedule) return false
  return !withinWorkingHours({ startsAt, endsAt, sessions: schedule.sessions, onLeave: schedule.onLeave })
}

/**
 * The doctor's appointments overlapping the IST day of `dateIso` that still hold the time:
 * every status except 'cancelled' (no-shows stay, matching hasSchedulingConflict, so a slot shown
 * free is one the booking conflict check accepts).
 */
export async function listBookedIntervals(providerId: number, dateIso: string): Promise<{ startsAt: Date; endsAt: Date }[]> {
  const dayStart = startOfIstDay(dateIso)
  const dayEnd = new Date(dayStart.getTime() + DAY_MS)
  return getDb().select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt }).from(appointments).where(and(
    eq(appointments.providerId, providerId),
    ne(appointments.status, 'cancelled'),
    lt(appointments.startsAt, dayEnd),
    gt(appointments.endsAt, dayStart),
  ))
}

/**
 * Replaces the slot length, every weekly session and the leave from `todayIso` onwards in one
 * transaction; earlier leave rows are kept as history. false for an unknown provider.
 */
export async function replaceProviderSchedule(providerId: number, input: ProviderScheduleInput, todayIso: string): Promise<boolean> {
  const found = await getDb().transaction(async (tx) => {
    const updated = await tx.update(providers).set({ slotMinutes: input.slotMinutes }).where(eq(providers.id, providerId)).returning({ id: providers.id })
    if (updated.length === 0) return false
    await tx.delete(providerSchedules).where(eq(providerSchedules.providerId, providerId))
    if (input.sessions.length > 0) {
      await tx.insert(providerSchedules).values(input.sessions.map((s) => ({ providerId, weekday: s.weekday, startTime: s.start, endTime: s.end })))
    }
    await tx.delete(providerLeave).where(and(eq(providerLeave.providerId, providerId), gte(providerLeave.leaveDate, todayIso)))
    if (input.leave.length > 0) {
      await tx.insert(providerLeave).values(input.leave.map((l) => ({ providerId, leaveDate: l.date, reason: l.reason })))
    }
    return true
  })
  // The cached active roster carries slot_minutes.
  if (found) await invalidateCache(providersListCacheKey())
  return found
}
