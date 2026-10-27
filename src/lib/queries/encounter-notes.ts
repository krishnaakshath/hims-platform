import { getDb } from '@/db/client'
import { encounterNotes, signatures } from '@/db/schema'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Role, Session } from '@/lib/auth'
import { NOTE_ATTESTATION, noteSignSchema } from '@/lib/encounters/note-signing'

export { NOTE_ATTESTATION, noteSignSchema }

export type EncounterNote = typeof encounterNotes.$inferSelect

export async function createNote(input: {
  patientId: string
  appointmentId: number | null
  admissionId: number | null
  encounterId?: number | null
  noteType: 'soap' | 'progress' | 'nursing' | 'discharge_summary'
  authorName: string
  authorRole: Role
  subjective: string | null
  objective: string | null
  assessment: string | null
  plan: string | null
}): Promise<EncounterNote> {
  const [created] = await getDb().insert(encounterNotes).values({
    patientId: input.patientId,
    appointmentId: input.appointmentId,
    admissionId: input.admissionId,
    encounterId: input.encounterId ?? null,
    noteType: input.noteType,
    authorName: input.authorName,
    authorRole: input.authorRole,
    subjective: input.subjective,
    objective: input.objective,
    assessment: input.assessment,
    plan: input.plan,
  }).returning()
  return created
}

export async function getNoteById(id: number): Promise<EncounterNote | null> {
  const rows = await getDb().select().from(encounterNotes).where(eq(encounterNotes.id, id))
  return rows[0] ?? null
}

export async function listNotesForPatient(patientId: string): Promise<EncounterNote[]> {
  return getDb().select().from(encounterNotes).where(eq(encounterNotes.patientId, patientId)).orderBy(desc(encounterNotes.createdAt))
}

/** WS1 T5: the notes written in one visit, newest first (the workspace Notes tab). */
export async function listNotesForEncounter(encounterId: number): Promise<EncounterNote[]> {
  return getDb().select().from(encounterNotes).where(eq(encounterNotes.encounterId, encounterId)).orderBy(desc(encounterNotes.createdAt), desc(encounterNotes.id))
}

// WS7 T5: stored verbatim in signatures.attestation_text for every signed note.
export const SIGN_NOTE_ATTESTATION = 'I confirm I wrote or reviewed this note and that it is accurate.'

export const NOTE_NOT_FOUND = 'Note not found'
export const NOTE_ALREADY_SIGNED = 'Note is already signed'

export type SignNoteResult =
  | { ok: true; signatureId?: number }
  | { ok: false; error: string }

export interface NoteSigner {
  name: string
  role: string
  isAdmin: boolean
  typedName: string
}

export async function checkNoteSignable(id: number, patientId: string, signerName: string, signerIsAdmin: boolean): Promise<SignNoteResult> {
  const note = await getNoteById(id)
  if (!note || note.patientId !== patientId) return { ok: false, error: NOTE_NOT_FOUND }
  if (note.status !== 'draft') return { ok: false, error: NOTE_ALREADY_SIGNED }
  if (note.authorName !== signerName && !signerIsAdmin) return { ok: false, error: 'Only the author can sign' }
  return { ok: true }
}

export async function signNote(
  noteId: number,
  patientId: string,
  input: { typedName: string; session: Session } | NoteSigner,
  attestationOverride?: string,
): Promise<SignNoteResult> {
  const isSessionInput = 'session' in input
  const signerName = isSessionInput ? input.session.name : input.name
  const signerRole = isSessionInput ? input.session.role : input.role
  const isAdmin = isSessionInput ? input.session.role === 'admin' : input.isAdmin
  const typedName = input.typedName

  if (typedName !== signerName.trim() && !isAdmin) {
    return { ok: false, error: 'Typed name does not match' }
  }

  const attestation = attestationOverride || (isSessionInput ? NOTE_ATTESTATION : SIGN_NOTE_ATTESTATION)

  return getDb().transaction(async (tx): Promise<SignNoteResult> => {
    const [note] = await tx.select().from(encounterNotes).where(eq(encounterNotes.id, noteId)).for('update')
    if (!note || note.patientId !== patientId) return { ok: false, error: NOTE_NOT_FOUND }
    if (note.status !== 'draft') return { ok: false, error: NOTE_ALREADY_SIGNED }
    if (note.authorName !== signerName && !isAdmin) return { ok: false, error: 'Only the author can sign' }

    const [signature] = await tx.insert(signatures).values({
      signableType: 'encounter_note',
      signableId: noteId,
      patientId,
      signerTypedName: typedName,
      signerRole,
      attestationText: attestation,
    }).returning({ id: signatures.id })

    await tx.update(encounterNotes).set({ status: 'signed', signedAt: new Date() }).where(eq(encounterNotes.id, noteId))
    return { ok: true, signatureId: signature.id }
  })
}
