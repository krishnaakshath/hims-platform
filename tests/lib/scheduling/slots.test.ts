import { describe, it, expect } from 'vitest'
import { buildSlots, withinWorkingHours, istWeekdayOf, type WeeklySession } from '@/lib/scheduling/slots'

// 2026-11-02 is a Monday.
const MON = '2026-11-02'
const MON_MORNING: WeeklySession[] = [{ weekday: 1, start: '09:00', end: '13:00' }]
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`)
const LONG_AGO = new Date('2020-01-01T00:00:00Z')

describe('istWeekdayOf', () => {
  it('reads the weekday of the calendar date, not of the server zone', () => {
    expect(istWeekdayOf(MON)).toBe(1)
    expect(istWeekdayOf('2026-11-08')).toBe(0)
  })
})

describe('buildSlots', () => {
  it('cuts Mon 09:00-13:00 at 15 minutes into 16 free slots on IST wall-clock instants', () => {
    const slots = buildSlots({ dateIso: MON, sessions: MON_MORNING, slotMinutes: 15, onLeave: false, booked: [], now: LONG_AGO })
    expect(slots).toHaveLength(16)
    expect(slots[0]).toEqual({ startsAt: ist(MON, '09:00'), endsAt: ist(MON, '09:15'), status: 'free' })
    expect(slots[15].endsAt).toEqual(ist(MON, '13:00'))
    expect(slots.every((s) => s.status === 'free')).toBe(true)
  })

  it('only uses sessions of the date’s weekday, in time order, and drops a trailing partial slot', () => {
    const sessions: WeeklySession[] = [
      { weekday: 1, start: '17:00', end: '17:50' },
      { weekday: 2, start: '09:00', end: '12:00' },
      { weekday: 1, start: '09:00', end: '09:30' },
    ]
    const slots = buildSlots({ dateIso: MON, sessions, slotMinutes: 20, onLeave: false, booked: [], now: LONG_AGO })
    expect(slots.map((s) => s.startsAt)).toEqual([ist(MON, '09:00'), ist(MON, '17:00'), ist(MON, '17:20')])
  })

  it('marks a slot overlapping a booking as booked', () => {
    const slots = buildSlots({
      dateIso: MON, sessions: MON_MORNING, slotMinutes: 15, onLeave: false, now: LONG_AGO,
      booked: [{ startsAt: ist(MON, '09:30'), endsAt: ist(MON, '09:45') }],
    })
    expect(slots.filter((s) => s.status === 'booked').map((s) => s.startsAt)).toEqual([ist(MON, '09:30')])
  })

  it('marks every slot that started before now as past (at 10:05 IST, slots up to 10:00)', () => {
    const slots = buildSlots({ dateIso: MON, sessions: MON_MORNING, slotMinutes: 15, onLeave: false, booked: [], now: ist(MON, '10:05') })
    const past = slots.filter((s) => s.status === 'past')
    expect(past).toHaveLength(5)
    expect(past.at(-1)!.startsAt).toEqual(ist(MON, '10:00'))
    expect(slots[5]).toMatchObject({ startsAt: ist(MON, '10:15'), status: 'free' })
  })

  it('returns no slots on a leave day', () => {
    expect(buildSlots({ dateIso: MON, sessions: MON_MORNING, slotMinutes: 15, onLeave: true, booked: [], now: LONG_AGO })).toEqual([])
  })
})

describe('withinWorkingHours', () => {
  it('is true only when the whole interval falls inside one session of that IST weekday', () => {
    const base = { sessions: MON_MORNING, onLeave: false }
    expect(withinWorkingHours({ ...base, startsAt: ist(MON, '09:00'), endsAt: ist(MON, '09:15') })).toBe(true)
    expect(withinWorkingHours({ ...base, startsAt: ist(MON, '12:45'), endsAt: ist(MON, '13:00') })).toBe(true)
    expect(withinWorkingHours({ ...base, startsAt: ist(MON, '12:50'), endsAt: ist(MON, '13:05') })).toBe(false)
    expect(withinWorkingHours({ ...base, startsAt: ist(MON, '08:45'), endsAt: ist(MON, '09:00') })).toBe(false)
    expect(withinWorkingHours({ ...base, startsAt: ist('2026-11-03', '09:00'), endsAt: ist('2026-11-03', '09:15') })).toBe(false)
  })

  it('is false on a leave day', () => {
    expect(withinWorkingHours({ sessions: MON_MORNING, onLeave: true, startsAt: ist(MON, '09:00'), endsAt: ist(MON, '09:15') })).toBe(false)
  })
})
