import { getDb } from '@/db/client'
import { encounterNotes } from '@/db/schema'
import { desc, eq } from 'drizzle-orm'
import type { Role } from '@/lib/auth'

export type EncounterNote = typeof encounterNotes.$inferSelect

export interface CreateNoteInput {
  patientId: string
  appointmentId: number | null
  admissionId: number | null
  noteType: 'progress' | 'nursing' | 'intake'
  authorName: string
  // Full Role, not narrowed to 'pi' | 'admin' -- POST .../notes/route.ts's
  // own runtime gate is what actually restricts who can call this; matches
  // the same widen-the-type/gate-at-runtime convention used elsewhere
  // (auditLog.role, messages.senderRole).
  authorRole: Role
  subjective: string | null
  objective: string | null
  assessment: string | null
  plan: string | null
}

export async function createNote(input: CreateNoteInput): Promise<EncounterNote> {
  const [created] = await getDb().insert(encounterNotes).values(input).returning()
  return created
}

export async function getNoteById(id: number): Promise<EncounterNote | null> {
  const [row] = await getDb().select().from(encounterNotes).where(eq(encounterNotes.id, id))
  return row ?? null
}

export async function listNotesForPatient(patientId: string): Promise<EncounterNote[]> {
  return getDb().select().from(encounterNotes).where(eq(encounterNotes.patientId, patientId)).orderBy(desc(encounterNotes.createdAt))
}

export interface SignNoteResult {
  ok: boolean
  error?: string
}

// Only the note's own author, or an admin, may sign it -- and only while
// it's still a draft. A row's status only ever moves draft -> signed, once;
// there is deliberately no route anywhere that can move it back or edit a
// signed row's content (append-only, same principle as the audit log).
//
// `patientId` is the URL's patient (the caller-supplied `anonId`) -- it must
// match the note's own `patientId` or the caller is signing a note through
// the wrong patient's URL. That's treated the same as "note not found"
// rather than a distinct error: it never confirms to the caller that a note
// with this id exists under a different patient, and it keeps the audit log
// (which the route logs against the URL's patient) from ever attributing a
// sign action to the wrong patient.
export async function signNote(id: number, patientId: string, signerName: string, signerIsAdmin: boolean): Promise<SignNoteResult> {
  const note = await getNoteById(id)
  if (!note || note.patientId !== patientId) return { ok: false, error: 'Note not found' }
  if (note.status !== 'draft') return { ok: false, error: 'Note is already signed' }
  if (note.authorName !== signerName && !signerIsAdmin) return { ok: false, error: 'Only the note\'s author or an admin may sign it' }

  const result = await getDb().update(encounterNotes).set({ status: 'signed', signedAt: new Date() }).where(eq(encounterNotes.id, id)).returning({ id: encounterNotes.id })
  return { ok: result.length > 0 }
}
