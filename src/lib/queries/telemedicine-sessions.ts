import { randomBytes } from 'crypto'
import { and, eq, ne, notInArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { appointments, telemedicineSessions } from '@/db/schema'

export type TelemedicineSessionStatus = 'scheduled' | 'waiting' | 'in_progress' | 'completed' | 'failed'

export interface TelemedicineSessionRow {
  id: number
  appointmentId: number
  appointmentProviderId: number
  appointmentPatientId: string
  patientJoinToken: string
  status: TelemedicineSessionStatus
  providerJoinedAt: Date | null
  patientJoinedAt: Date | null
  endedAt: Date | null
  createdAt: Date
}

function mapRow(r: { session: typeof telemedicineSessions.$inferSelect; appointment: typeof appointments.$inferSelect }): TelemedicineSessionRow {
  return {
    id: r.session.id,
    appointmentId: r.session.appointmentId,
    appointmentProviderId: r.appointment.providerId,
    appointmentPatientId: r.appointment.patientId,
    patientJoinToken: r.session.patientJoinToken,
    status: r.session.status,
    providerJoinedAt: r.session.providerJoinedAt,
    patientJoinedAt: r.session.patientJoinedAt,
    endedAt: r.session.endedAt,
    createdAt: r.session.createdAt,
  }
}

export async function getSessionById(id: number): Promise<TelemedicineSessionRow | null> {
  const [row] = await getDb()
    .select({ session: telemedicineSessions, appointment: appointments })
    .from(telemedicineSessions)
    .innerJoin(appointments, eq(telemedicineSessions.appointmentId, appointments.id))
    .where(eq(telemedicineSessions.id, id))
  return row ? mapRow(row) : null
}

export async function getSessionByAppointmentId(appointmentId: number): Promise<TelemedicineSessionRow | null> {
  const [row] = await getDb()
    .select({ session: telemedicineSessions, appointment: appointments })
    .from(telemedicineSessions)
    .innerJoin(appointments, eq(telemedicineSessions.appointmentId, appointments.id))
    .where(eq(telemedicineSessions.appointmentId, appointmentId))
  return row ? mapRow(row) : null
}

export async function getSessionByToken(token: string): Promise<TelemedicineSessionRow | null> {
  const [row] = await getDb()
    .select({ session: telemedicineSessions, appointment: appointments })
    .from(telemedicineSessions)
    .innerJoin(appointments, eq(telemedicineSessions.appointmentId, appointments.id))
    .where(eq(telemedicineSessions.patientJoinToken, token))
  return row ? mapRow(row) : null
}

const ALREADY_EXISTS_ERROR = 'A telemedicine session already exists for this appointment'
// Postgres SQLSTATE for unique_violation -- the `node-postgres` driver
// (src/db/client.ts uses `pg`, not the Neon HTTP driver) throws plain
// Error-like objects carrying this on `.code` for any constraint violation.
const POSTGRES_UNIQUE_VIOLATION = '23505'

export async function createTelemedicineSession(appointmentId: number): Promise<{ ok: boolean; error?: string; session?: TelemedicineSessionRow }> {
  const [existing] = await getDb().select().from(telemedicineSessions).where(eq(telemedicineSessions.appointmentId, appointmentId))
  if (existing) return { ok: false, error: ALREADY_EXISTS_ERROR }

  const patientJoinToken = randomBytes(32).toString('base64url')
  let created: typeof telemedicineSessions.$inferSelect
  try {
    ;[created] = await getDb().insert(telemedicineSessions).values({ appointmentId, patientJoinToken }).returning()
  } catch (error) {
    // Two concurrent calls for the same appointmentId can both pass the
    // SELECT above before either INSERTs -- the loser hits this unique
    // constraint (telemedicineSessions.appointmentId.unique(), from Task 1)
    // instead of the pre-check. Without this catch, that loser would surface
    // as an unhandled 500 instead of the same clean `{ ok: false }` shape
    // the pre-check already returns for the non-racing case.
    if ((error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
      return { ok: false, error: ALREADY_EXISTS_ERROR }
    }
    throw error
  }

  const session = await getSessionById(created.id)
  return { ok: true, session: session! }
}

export async function markProviderJoined(sessionId: number): Promise<void> {
  await getDb().update(telemedicineSessions)
    .set({
      providerJoinedAt: sql`COALESCE(${telemedicineSessions.providerJoinedAt}, now())`,
      status: sql`CASE WHEN ${telemedicineSessions.status} = 'scheduled' THEN 'waiting'::telemedicine_session_status ELSE ${telemedicineSessions.status} END`,
    })
    .where(and(eq(telemedicineSessions.id, sessionId), notInArray(telemedicineSessions.status, ['completed', 'failed'])))
}

export async function markPatientJoined(sessionId: number): Promise<void> {
  await getDb().update(telemedicineSessions)
    .set({
      patientJoinedAt: sql`COALESCE(${telemedicineSessions.patientJoinedAt}, now())`,
      status: sql`CASE WHEN ${telemedicineSessions.status} = 'waiting' AND ${telemedicineSessions.providerJoinedAt} IS NOT NULL THEN 'in_progress'::telemedicine_session_status ELSE ${telemedicineSessions.status} END`,
    })
    .where(and(eq(telemedicineSessions.id, sessionId), notInArray(telemedicineSessions.status, ['completed', 'failed'])))
}

export async function endSession(sessionId: number): Promise<{ ok: boolean; error?: string }> {
  const updated = await getDb().update(telemedicineSessions)
    .set({ status: 'completed', endedAt: new Date() })
    .where(and(eq(telemedicineSessions.id, sessionId), ne(telemedicineSessions.status, 'completed')))
    .returning({ id: telemedicineSessions.id })

  if (updated.length === 0) return { ok: false, error: 'Session already ended' }
  return { ok: true }
}
