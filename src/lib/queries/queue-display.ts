import { getDb } from '@/db/client'
import { doctorAssignments, appointments, admissions, encounters, providers, rooms, patients } from '@/db/schema'
import { and, eq, gte, lt, ne } from 'drizzle-orm'
import { istDayBounds } from '@/lib/india-time'
import { notArchived } from './patient-archive' // WS8 T13

export type QueueDisplayStage = 'waiting' | 'ready'

export interface QueueDisplayRow {
  ticketNumber: number
  urgency: 'routine' | 'urgent' | 'emergency'
  stage: QueueDisplayStage
  // WS6 T10: the doctor's name and where to go. Never a patient identifier.
  providerName: string
  room: string | null
}

// Reuses doctorAssignments/rooms/admissions/appointments -- no new status
// enum (spec §4). Scoped to "today" (see this plan's "Scope decisions" #2):
// the IST business day, the same day OPD tokens restart on (SP3), whatever
// zone the server runs in.
export async function getQueueDisplayRows(): Promise<QueueDisplayRow[]> {
  const db = getDb()
  const today = istDayBounds()
  const rows = await db
    .select({
      queueTicketNumber: doctorAssignments.queueTicketNumber,
      urgency: doctorAssignments.urgency,
      status: doctorAssignments.status,
      roomId: doctorAssignments.roomId,
      appointmentId: doctorAssignments.appointmentId,
      appointmentStatus: appointments.status,
      admissionId: admissions.id,
      encounterStatus: encounters.status, // SP3
      visitType: doctorAssignments.visitType, // WS6 T10
      providerName: providers.name, // WS6 T10
      opdRoom: providers.opdRoom, // WS6 T10
      bedWard: rooms.ward, // WS6 T10
      bedRoomNumber: rooms.roomNumber, // WS6 T10
    })
    .from(doctorAssignments)
    .innerJoin(patients, eq(patients.id, doctorAssignments.patientId)) // WS8 T13: archived charts leave the board
    .leftJoin(appointments, eq(doctorAssignments.appointmentId, appointments.id))
    .leftJoin(admissions, eq(admissions.createdFromAssignmentId, doctorAssignments.id))
    .leftJoin(encounters, eq(encounters.doctorAssignmentId, doctorAssignments.id)) // SP3
    .innerJoin(providers, eq(providers.id, doctorAssignments.providerId)) // WS6 T10
    .leftJoin(rooms, eq(rooms.id, doctorAssignments.roomId)) // WS6 T10
    .where(and(gte(doctorAssignments.createdAt, today.start), lt(doctorAssignments.createdAt, today.end), ne(doctorAssignments.status, 'declined'), notArchived()))

  const result: QueueDisplayRow[] = []
  for (const row of rows) {
    // Task 1's DEFAULT 0 on doctorAssignments.queueTicketNumber is a
    // cross-worktree safety net for other branches' code that doesn't know
    // about this column -- it is never a real ticket number (see the
    // DEFAULT 0 comment on doctorAssignments in src/db/schema.ts). Rows
    // that slipped through with a 0 (or, defensively, any non-positive
    // value) must never render on the public lobby board as an
    // indistinguishable "0" ticket.
    if (row.queueTicketNumber <= 0) continue
    if (row.admissionId !== null) continue // already admitted -- no longer waiting in the lobby
    // 'cancelled'/'no_show' visits are as done-with as 'completed' from the
    // lobby board's point of view -- none of the three should keep a ticket
    // showing as perpetually "Ready".
    if (row.appointmentStatus === 'completed' || row.appointmentStatus === 'cancelled' || row.appointmentStatus === 'no_show') continue
    // SP3: a finished or cancelled visit leaves the lobby board.
    if (row.encounterStatus === 'completed' || row.encounterStatus === 'cancelled') continue
    // WS6 T10: OPD goes to the doctor's OPD room; a bed assignment to the bed's room.
    const bedRoom = row.bedRoomNumber !== null ? `${row.bedWard} ${row.bedRoomNumber}` : null
    const room = row.visitType === 'outpatient' ? (row.opdRoom ?? bedRoom) : bedRoom
    const base = { ticketNumber: row.queueTicketNumber, urgency: row.urgency, providerName: row.providerName, room }
    if (row.status === 'pending') {
      result.push({ ...base, stage: 'waiting' })
    } else if (row.status === 'scheduled' && row.roomId !== null) {
      result.push({ ...base, stage: 'ready' })
    } else if (row.status === 'scheduled' && row.roomId === null && row.appointmentId !== null && row.encounterStatus === 'checked_in') {
      // SP3: checked in against a booked appointment (e.g. a follow-up) -- the
      // assignment is born 'scheduled', and the patient waits in the lobby.
      result.push({ ...base, stage: 'waiting' })
    }
    // Any other 'scheduled' with no roomId has no bucket here -- see "Scope decisions" #3.
  }
  return result.sort((a, b) => a.ticketNumber - b.ticketNumber)
}
