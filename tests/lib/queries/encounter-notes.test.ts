import { describe, it, expect, afterEach } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, encounterNotes, signatures } from '@/db/schema'
import { createNote, signNote, listNotesForPatient, getNoteById, SIGN_NOTE_ATTESTATION } from '@/lib/queries/encounter-notes'

const signer = (name: string, isAdmin: boolean) => ({ name, role: isAdmin ? 'admin' : 'pi', isAdmin, typedName: name })
const as = (name: string, role: 'pi' | 'admin' = 'pi') => ({ typedName: name, session: { name, role, userId: null } })

const createdNoteIds: number[] = []
afterEach(async () => {
  if (createdNoteIds.length > 0) await getDb().delete(signatures).where(and(eq(signatures.signableType, 'encounter_note'), inArray(signatures.signableId, createdNoteIds)))
  while (createdNoteIds.length > 0) await getDb().delete(encounterNotes).where(eq(encounterNotes.id, createdNoteIds.pop()!))
})

describe('encounter notes queries', () => {
  it('creates and reads a note', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const created = await createNote({
      patientId: patientRow.id,
      appointmentId: null,
      admissionId: null,
      noteType: 'progress',
      authorName: 'Dr. R. Kunam',
      authorRole: 'pi',
      subjective: 'Feeling better',
      objective: null,
      assessment: null,
      plan: null,
    })
    createdNoteIds.push(created.id)

    const byId = await getNoteById(created.id)
    expect(byId?.subjective).toBe('Feeling better')

    const signed = await signNote(created.id, patientRow.id, as('Dr. R. Kunam'))
    expect(signed.ok).toBe(true)
    const afterSign = await getNoteById(created.id)
    expect(afterSign?.status).toBe('signed')
  })

  it('rejects signing by non-author non-admin', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const created = await createNote({ patientId: patientRow.id, appointmentId: null, admissionId: null, noteType: 'progress', authorName: 'Dr. R. Kunam', authorRole: 'pi', subjective: null, objective: null, assessment: null, plan: null })
    createdNoteIds.push(created.id)

    const result = await signNote(created.id, patientRow.id, as('Someone Else'))
    expect(result.ok).toBe(false)
  })

  it('allows signing by admin even if not author', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const created = await createNote({ patientId: patientRow.id, appointmentId: null, admissionId: null, noteType: 'progress', authorName: 'Dr. R. Kunam', authorRole: 'pi', subjective: null, objective: null, assessment: null, plan: null })
    createdNoteIds.push(created.id)

    const result = await signNote(created.id, patientRow.id, as('Test Admin', 'admin'))
    expect(result.ok).toBe(true)
  })

  it('rejects signing note belonging to a different patient', async () => {
    const patientRows = await getDb().select().from(patients).limit(2)
    if (patientRows.length < 2) return

    const [patientA, patientB] = patientRows
    const created = await createNote({ patientId: patientA.id, appointmentId: null, admissionId: null, noteType: 'progress', authorName: 'Dr. R. Kunam', authorRole: 'pi', subjective: null, objective: null, assessment: null, plan: null })
    createdNoteIds.push(created.id)

    const result = await signNote(created.id, patientB.id, as('Dr. R. Kunam'))
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Note not found')

    const afterAttempt = await getNoteById(created.id)
    expect(afterAttempt?.status).toBe('draft')
  })
})
