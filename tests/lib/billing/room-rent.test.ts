import { describe, expect, it } from 'vitest'
import { planRoomRentDays } from '@/lib/billing/room-rent'

const A = { roomId: 1, ward: 'General', roomCategoryCode: 'GEN' }; const B = { roomId: 2, ward: 'ICU', roomCategoryCode: 'ICU' }
const dates = (d: { date: string }[]) => d.map((x) => x.date)

describe('room-rent census planner', () => {
  it('bills census nights and not the discharge day', () => {
    const d = planRoomRentDays({ admittedAt: new Date('2026-10-20T05:00:00Z'), dischargedAt: new Date('2026-10-23T06:00:00Z'), now: new Date('2026-10-30T00:00:00Z'), initialRoom: A, transfers: [] })
    expect(dates(d)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22'])
  })
  it('same-day admit and discharge bills one day', () => {
    expect(planRoomRentDays({ admittedAt: new Date('2026-10-20T03:00:00Z'), dischargedAt: new Date('2026-10-20T10:00:00Z'), now: new Date('2026-10-21T00:00:00Z'), initialRoom: A, transfers: [] })).toEqual([{ date: '2026-10-20', room: A }])
  })
  it('census day ends at IST midnight', () => {
    // admitted 23:50 IST on 20 Oct (18:20Z); still admitted at 21 Oct 00:05 IST (18:35Z)
    expect(dates(planRoomRentDays({ admittedAt: new Date('2026-10-20T18:20:00Z'), dischargedAt: null, now: new Date('2026-10-20T18:35:00Z'), initialRoom: A, transfers: [] }))).toEqual(['2026-10-20'])
    // one minute before IST midnight nothing is billable yet
    expect(planRoomRentDays({ admittedAt: new Date('2026-10-20T18:20:00Z'), dischargedAt: null, now: new Date('2026-10-20T18:29:00Z'), initialRoom: A, transfers: [] })).toEqual([])
  })
  it('a day takes the room held at its end', () => {
    const d = planRoomRentDays({ admittedAt: new Date('2026-10-20T05:00:00Z'), dischargedAt: null, now: new Date('2026-10-22T19:00:00Z'), initialRoom: A, transfers: [{ at: new Date('2026-10-21T12:00:00Z'), toRoom: B }] })
    expect(d).toEqual([{ date: '2026-10-20', room: A }, { date: '2026-10-21', room: B }, { date: '2026-10-22', room: B }])
  })
  it('a transfer after the end of a day does not change that day, and transfers need not arrive sorted', () => {
    const C = { roomId: 3, ward: 'Private', roomCategoryCode: 'PVT' }
    const d = planRoomRentDays({
      admittedAt: new Date('2026-10-20T05:00:00Z'), dischargedAt: null, now: new Date('2026-10-23T19:00:00Z'), initialRoom: A,
      transfers: [{ at: new Date('2026-10-22T12:00:00Z'), toRoom: C }, { at: new Date('2026-10-21T12:00:00Z'), toRoom: B }],
    })
    expect(d.map((x) => x.room)).toEqual([A, B, C, C])
  })
  it('a transfer exactly at the end of the day belongs to the next day', () => {
    // 21 Oct 00:00 IST = 20 Oct 18:30Z
    const d = planRoomRentDays({ admittedAt: new Date('2026-10-20T05:00:00Z'), dischargedAt: null, now: new Date('2026-10-21T19:00:00Z'), initialRoom: A, transfers: [{ at: new Date('2026-10-20T18:30:00Z'), toRoom: B }] })
    expect(d.map((x) => x.room)).toEqual([A, B])
  })
  it('discharge exactly at IST midnight still bills the day just ended', () => {
    const d = planRoomRentDays({ admittedAt: new Date('2026-10-20T05:00:00Z'), dischargedAt: new Date('2026-10-20T18:30:00Z'), now: new Date('2026-10-25T00:00:00Z'), initialRoom: A, transfers: [] })
    expect(dates(d)).toEqual(['2026-10-20'])
  })
  it('an admission with no known room still plans days', () => {
    expect(planRoomRentDays({ admittedAt: new Date('2026-10-20T05:00:00Z'), dischargedAt: null, now: new Date('2026-10-21T19:00:00Z'), initialRoom: null, transfers: [] })).toEqual([{ date: '2026-10-20', room: null }, { date: '2026-10-21', room: null }])
  })
  it('crosses the month boundary by calendar date', () => {
    expect(dates(planRoomRentDays({ admittedAt: new Date('2026-10-30T05:00:00Z'), dischargedAt: new Date('2026-11-02T05:00:00Z'), now: new Date('2026-11-05T00:00:00Z'), initialRoom: A, transfers: [] })))
      .toEqual(['2026-10-30', '2026-10-31', '2026-11-01'])
  })
})
