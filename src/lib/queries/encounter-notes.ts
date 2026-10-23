import { getDb } from '@/db/client'
import { encounterNotes, signatures } from '@/db/schema'
import { desc, eq } from 'drizzle-orm'
import type { Role, Session } from '@/lib/auth'
import { NOTE_ATTESTATION } from '@/lib/encounters/note-signing'

export { NOTE_ATTESTATION, noteSignSchema } from '@/lib/encounters/note-signing'

export type EncounterNote = typeof encounterNotes.$inferSelect

export interface CreateNoteInput {
  patientId: string
  appointmentId: number | null
  admissionId: number | null
  /** WS1 T5: the visit the note was written in (the route checks it belongs to the patient). */
  encounterId?: number | null
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

/** WS1 T5: the notes written in one visit, newest first (the workspace Notes tab). */
export async function listNotesForEncounter(encounterId: number): Promise<EncounterNote[]> {
  return getDb().select().from(encounterNotes).where(eq(encounterNotes.encounterId, encounterId)).orderBy(desc(encounterNotes.createdAt), desc(encounterNotes.id))
}

export type SignNoteResult =
  | { ok: true; signatureId: number }
  | { ok: false; error: 'Note not found' | 'Note is already signed' | 'Only the author can sign' | 'Typed name does not match' }

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
//
// WS1 T5 (spec ruling 10): the signer also types their name, which must equal their session name
// (admin exempt, as discharge), and a signatures row of type encounter_note (with the exact
// attestation sentence) is written in the same transaction as the status change. The note row is
// locked first, so two concurrent signs cannot both write a signature.
export async function signNote(noteId: number, patientId: string, input: { typedName: string; session: Session }): Promise<SignNoteResult> {
  const { typedName, session } = input
  const isAdmin = session.role === 'admin'
  return getDb().transaction(async (tx): Promise<SignNoteResult> => {
    const [note] = await tx.select().from(encounterNotes).where(eq(encounterNotes.id, noteId)).for('update')
    if (!note || note.patientId !== patientId) return { ok: false, error: 'Note not found' }
    if (note.status !== 'draft') return { ok: false, error: 'Note is already signed' }
    if (note.authorName !== session.name && !isAdmin) return { ok: false, error: 'Only the author can sign' }
    if (typedName !== session.name && !isAdmin) return { ok: false, error: 'Typed name does not match' }

    const [signature] = await tx.insert(signatures).values({
      signableType: 'encounter_note',
      signableId: noteId,
      signerTypedName: typedName,
      signerRole: session.role,
      attestationText: NOTE_ATTESTATION,
    }).returning({ id: signatures.id })
    await tx.update(encounterNotes).set({ status: 'signed', signedAt: new Date() }).where(eq(encounterNotes.id, noteId))
    return { ok: true, signatureId: signature.id }
  })
}
