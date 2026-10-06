import { getDb } from '@/db/client'
import { messages, patients } from '@/db/schema'
import { eq, and, isNull, asc, desc, inArray, sql } from 'drizzle-orm'

export type SenderRole = 'provider' | 'patient' | 'system'

/**
 * A single patient's message thread, oldest first (chat reading order).
 * Not cached -- unlike the read-mostly workbook lists elsewhere in this app,
 * a message thread's whole point is to reflect a reply the instant it's
 * sent, and this table is small enough per-patient that a live read is fine.
 */
export async function listMessagesForPatient(patientId: string) {
  return getDb().select().from(messages).where(eq(messages.patientId, patientId)).orderBy(asc(messages.createdAt))
}

/**
 * Same thread, minus internal (staff-to-staff) notes -- the only version of
 * a patient's thread the patient portal, or anything deriving a
 * patient-facing count from it, may ever read.
 */
export async function listPatientVisibleMessages(patientId: string) {
  return getDb().select().from(messages)
    .where(and(eq(messages.patientId, patientId), eq(messages.internal, false)))
    .orderBy(asc(messages.createdAt))
}

// `db` is the shared client by default; a caller that must commit the message
// atomically with another write (notifyPatientOfScheduledAssignment) passes
// its transaction handle instead -- same executor pattern as
// copyTemplateConsentsToSubmission in form-submission-consents.ts.
export async function sendMessage(
  patientId: string,
  senderRole: SenderRole,
  senderName: string,
  body: string,
  internal = false,
  db: Pick<ReturnType<typeof getDb>, 'insert'> = getDb(),
) {
  const [created] = await db.insert(messages).values({ patientId, senderRole, senderName, body, internal }).returning()
  return created
}

/** Marks every patient-authored message in this thread as read by staff. */
export async function markReadByProvider(patientId: string): Promise<void> {
  await getDb()
    .update(messages)
    .set({ readByProviderAt: new Date() })
    .where(and(eq(messages.patientId, patientId), eq(messages.senderRole, 'patient'), isNull(messages.readByProviderAt)))
}

/**
 * Marks every provider- or system-authored message in this thread as read by
 * the patient. From the patient's side an automated notice is a message from
 * the practice they need to see, so it counts toward their badge and is
 * marked read the same way as a provider message (spec §5).
 */
export async function markReadByPatient(patientId: string): Promise<void> {
  await getDb()
    .update(messages)
    .set({ readByPatientAt: new Date() })
    .where(and(eq(messages.patientId, patientId), inArray(messages.senderRole, ['provider', 'system']), eq(messages.internal, false), isNull(messages.readByPatientAt)))
}

/** Total unread (by staff) patient-authored messages across every thread -- for a nav badge. */
export async function getUnreadCountForProvider(): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.senderRole, 'patient'), isNull(messages.readByProviderAt)))
  return row?.count ?? 0
}

/**
 * Unread (by the patient) provider- or system-authored messages in this
 * patient's own thread. From the patient's side an automated notice is a
 * message from the practice they need to see, so it counts toward their
 * badge the same way a provider message does (spec §5).
 */
export async function getUnreadCountForPatient(patientId: string): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.patientId, patientId), inArray(messages.senderRole, ['provider', 'system']), eq(messages.internal, false), isNull(messages.readByPatientAt)))
  return row?.count ?? 0
}

/**
 * One row per patient who has at least one message, most-recently-active
 * thread first, for the doctor-side inbox list. Deliberately not restricted
 * to a specific doctor's own patients -- see the same "no real doctor
 * assignment table" limitation noted on `patients.currentProvider` and in
 * (dashboard)/doctor/page.tsx -- any staff member can message any patient.
 */
export async function listMessageThreads() {
  const db = getDb()
  // Grouped and sorted in JS rather than with a SQL aggregate -- this
  // pilot's message volume is small (a handful of patients, same scale
  // assumption as invalidateCacheByPrefix in lib/cache.ts), and doing it
  // this way keeps the query trivially correct without relying on ordering
  // by a SQL-side alias.
  const all = await db.select().from(messages).orderBy(desc(messages.createdAt))
  if (all.length === 0) return []

  const patientIds = [...new Set(all.map((m) => m.patientId))]
  const patientRows = await db
    .select({ id: patients.id, name: patients.name })
    .from(patients)
    .where(inArray(patients.id, patientIds))
  const nameById = new Map(patientRows.map((p) => [p.id, p.name]))

  const threads = new Map<string, { patientId: string; patientName: string; lastMessageAt: Date; unreadByProviderCount: number; lastMessagePreview: (typeof all)[number] }>()
  for (const m of all) {
    const existing = threads.get(m.patientId)
    if (existing) {
      if (m.senderRole === 'patient' && !m.readByProviderAt) existing.unreadByProviderCount += 1
      continue
    }
    threads.set(m.patientId, {
      patientId: m.patientId,
      patientName: nameById.get(m.patientId) ?? m.patientId,
      lastMessageAt: m.createdAt,
      unreadByProviderCount: m.senderRole === 'patient' && !m.readByProviderAt ? 1 : 0,
      lastMessagePreview: m,
    })
  }

  // `all` is already sorted newest-first, and each thread's `lastMessageAt`
  // comes from the first (i.e. newest) message seen for that patient, so
  // insertion order into the Map already matches the desired sort.
  return [...threads.values()]
}

/** The display name to attribute a patient-authored message to, at send time. */
export async function getPatientDisplayName(patientId: string): Promise<string | null> {
  const [row] = await getDb().select({ name: patients.name }).from(patients).where(eq(patients.id, patientId))
  if (!row) return null
  return row.name
}
