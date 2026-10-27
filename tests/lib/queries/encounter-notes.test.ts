import { describe, it, expect, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, encounterNotes, signatures } from '@/db/schema'
import { createNote, signNote, listNotesForPatient, getNoteById } from '@/lib/queries/encounter-notes'

// WS1 T5: signNote(noteId, patientId, { typedName, session }).
const as = (name: string, role: 'pi' | 'admin' = 'pi') => ({ typedName: name, session: { name, role, userId: null } })

const createdNoteIds: number[] = []
afterEach(async () => {
  while (createdNoteIds.length > 0) {
    const noteId = createdNoteIds.pop()!
    await getDb().delete(signatures).where(and(eq(signatures.signableType, 'encounter_note'), eq(signatures.signableId, noteId)))
    await getDb().delete(encounterNotes).where(eq(encounterNotes.id, noteId))
  }
})

describe('encounter notes queries', () => {
  it('creates a draft note, reads it back, then signs it', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)

    const created = await createNote({ patientId: patientRow.id, appointmentId: null, admissionId: null, noteType: 'progress', authorName: 'Dr. R. Kunam', authorRole: 'pi', subjective: 'Feeling better', objective: null, assessment: null, plan: 'Continue current dose' })
    createdNoteIds.push(created.id)
    expect(created.status).toBe('draft')

    const byId = await getNoteById(created.id)
    expect(byId?.subjective).toBe('Feeling better')

    const signed = await signNote(created.id, patientRow.id, as('Dr. R. Kunam'))
    expect(signed.ok).toBe(true)
    const afterSign = await getNoteById(created.id)
    expect(afterSign?.status).toBe('signed')
    expect(afterSign?.signedAt).not.toBeNull()
  })

  it('rejects signing by someone who is not the author and not an admin', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const created = await createNote({ patientId: patientRow.id, appointmentId: null, admissionId: null, noteType: 'progress', authorName: 'Dr. R. Kunam', authorRole: 'pi', subjective: null, objective: null, assessment: null, plan: null })
    createdNoteIds.push(created.id)

    const result = await signNote(created.id, patientRow.id, as('Someone Else'))
    expect(result.ok).toBe(false)
  })

  it('allows an admin to sign a note authored by someone else', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const created = await createNote({ patientId: patientRow.id, appointmentId: null, admissionId: null, noteType: 'progress', authorName: 'Dr. R. Kunam', authorRole: 'pi', subjective: null, objective: null, assessment: null, plan: null })
    createdNoteIds.push(created.id)

    const result = await signNote(created.id, patientRow.id, as('Test Admin', 'admin'))
    expect(result.ok).toBe(true)
  })

  it('rejects signing a note when the supplied patientId does not match the note\'s own patient', async () => {
    const patientRows = await getDb().select().from(patients).limit(2)
    if (patientRows.length < 2) throw new Error('This test needs at least 2 seeded patients -- run npm run db:seed')
    const [patientA, patientB] = patientRows

    const created = await createNote({ patientId: patientA.id, appointmentId: null, admissionId: null, noteType: 'progress', authorName: 'Dr. R. Kunam', authorRole: 'pi', subjective: null, objective: null, assessment: null, plan: null })
    createdNoteIds.push(created.id)

    const result = await signNote(created.id, patientB.id, as('Dr. R. Kunam'))
    expect(result).toEqual({ ok: false, error: 'Note not found' })

    const afterAttempt = await getNoteById(created.id)
    expect(afterAttempt?.status).toBe('draft')
  })

  it('lists notes for a patient newest first', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const first = await createNote({ patientId: patientRow.id, appointmentId: null, admissionId: null, noteType: 'progress', authorName: 'A', authorRole: 'pi', subjective: null, objective: null, assessment: null, plan: null })
    createdNoteIds.push(first.id)
    const second = await createNote({ patientId: patientRow.id, appointmentId: null, admissionId: null, noteType: 'nursing', authorName: 'B', authorRole: 'admin', subjective: null, objective: null, assessment: null, plan: null })
    createdNoteIds.push(second.id)

    const list = await listNotesForPatient(patientRow.id)
    const ids = list.map((n) => n.id)
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id))
  })
})
