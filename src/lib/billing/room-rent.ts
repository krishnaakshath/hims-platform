// Pure room-rent census planner. A day is billed by IST-midnight census: the patient is a
// "night" of date d when still admitted at the end of d, priced by the room held at that instant.
import { addDaysIso } from '@/lib/follow-ups/rules'
import { istDateOf, startOfIstDay } from '@/lib/india-time'

export interface StayRoom { roomId: number; ward: string; roomCategoryCode: string | null }
export interface CensusDay { date: string; room: StayRoom | null }

export function planRoomRentDays(input: {
  admittedAt: Date
  dischargedAt: Date | null
  now: Date
  initialRoom: StayRoom | null
  transfers: { at: Date; toRoom: StayRoom }[]
}): CensusDay[] {
  const { admittedAt, dischargedAt, now, initialRoom } = input
  const transfers = [...input.transfers].sort((a, b) => a.at.getTime() - b.at.getTime())
  const admitDate = istDateOf(admittedAt)
  const days: CensusDay[] = []

  // Bounded by the span of the stay; each pass either bills a day or stops.
  for (let date = admitDate; ; date = addDaysIso(date, 1)) {
    const end = startOfIstDay(addDaysIso(date, 1))
    // Discharged: the admission date is always billed (minimum one day); later dates need the patient
    // to be there at their end. Admitted: only days that have ended.
    const billable = dischargedAt !== null
      ? date === admitDate || dischargedAt.getTime() >= end.getTime()
      : end.getTime() <= now.getTime()
    if (!billable) break
    let room = initialRoom
    for (const t of transfers) if (t.at.getTime() < end.getTime()) room = t.toRoom
    days.push({ date, room })
  }
  return days
}
