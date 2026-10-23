// WS1 T5 (spec ruling 10): signing a clinical note needs { typedName, attestation: true }; the
// typed name must equal the session name (admin exempt); a signatures row of type encounter_note
// is written with the note's status change. Notes may link to a visit of the same patient.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, encounterNotes, encounters, patients, providers, signatures } from '@/db/schema'

let role = 'pi'
let name = `TEST_WS1T5N-${Date.now()}`
const PROBE = name
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name, userId: null })) }))
let actingProvider: { id: number; name: string } | null = null
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => actingProvider) }))

import { POST as postNote } from '@/app/api/patients/[anonId]/notes/route'
import { PUT as putSign } from '@/app/api/patients/[anonId]/notes/[id]/sign/route'
import { NOTE_ATTESTATION } from '@/lib/queries/encounter-notes'

const PATIENT = `TWS1T5N-${Date.now()}`
const OTHER = `TWS1T5O-${Date.now()}`
const create = (patientId: string, body: unknown) =>
  postNote(new NextRequest(`http://localhost/api/patients/${patientId}/notes`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ anonId: patientId }) })
const sign = (noteId: number, body?: unknown, patientId = PATIENT) =>
  putSign(new NextRequest(`http://localhost/api/patients/${patientId}/notes/${noteId}/sign`, {
    method: 'PUT', ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), { params: Promise.resolve({ anonId: patientId, id: String(noteId) }) })

describe.skipIf(!process.env.DATABASE_URL)('note signing with typed name and attestation (DB)', () => {
  let providerId = 0
  let encounterId = 0
  let otherEncounterId = 0
  let otherDoctorId = 0
  let othersVisitId = 0
  let cancelledVisitId = 0
  let completedVisitId = 0
  const noteIds: number[] = []
  const newNote = async (body: Record<string, unknown> = {}) => {
    const res = await create(PATIENT, { noteType: 'progress', subjective: 'SECRET-NOTE-TEXT', ...body })
    expect(res.status).toBe(201)
    const note = await res.json()
    noteIds.push(note.id)
    return note as { id: number; encounterId: number | null; status: string }
  }
  const signaturesOf = (noteId: number) => getDb().select().from(signatures)
    .where(and(eq(signatures.signableType, 'encounter_note'), eq(signatures.signableId, noteId)))

  beforeAll(async () => {
    const db = getDb()
    const [p] = await db.insert(providers).values({ name: `${PROBE} Dr`, specialty: 'Test', colorTag: '#000000' }).returning()
    providerId = p.id
    await db.insert(patients).values([
      { id: PATIENT, name: 'TEST_WS1T5 Notes', dob: '1980-01-01', gender: 'female', uhid: `${PATIENT}-UH` },
      { id: OTHER, name: 'TEST_WS1T5 Other', dob: '1980-01-01', gender: 'male', uhid: `${OTHER}-UH` },
    ])
    const [e] = await db.insert(encounters).values({ patientId: PATIENT, encounterType: 'opd', encounterDate: '2026-10-01', providerId, status: 'in_consultation', checkedInByName: PROBE }).returning()
    const [o] = await db.insert(encounters).values({ patientId: OTHER, encounterType: 'opd', encounterDate: '2026-10-01', providerId, status: 'in_consultation', checkedInByName: PROBE }).returning()
    encounterId = e.id
    otherEncounterId = o.id
    const [d] = await db.insert(providers).values({ name: `${PROBE} Dr Other`, specialty: 'Test', colorTag: '#000000' }).returning()
    otherDoctorId = d.id
    const visit = (providerId: number, status: 'in_consultation' | 'cancelled' | 'completed') => db.insert(encounters)
      .values({ patientId: PATIENT, encounterType: 'opd', encounterDate: '2026-10-01', providerId, status, checkedInByName: PROBE }).returning()
    othersVisitId = (await visit(otherDoctorId, 'in_consultation'))[0].id
    cancelledVisitId = (await visit(providerId, 'cancelled'))[0].id
    completedVisitId = (await visit(providerId, 'completed'))[0].id
  })

  afterAll(async () => {
    const db = getDb()
    if (noteIds.length) await db.delete(signatures).where(and(eq(signatures.signableType, 'encounter_note'), inArray(signatures.signableId, noteIds)))
    await db.delete(encounterNotes).where(inArray(encounterNotes.patientId, [PATIENT, OTHER]))
    await db.delete(encounters).where(inArray(encounters.id, [encounterId, otherEncounterId, othersVisitId, cancelledVisitId, completedVisitId]))
    await db.delete(patients).where(inArray(patients.id, [PATIENT, OTHER]))
    await db.delete(providers).where(inArray(providers.id, [providerId, otherDoctorId]))
    await db.delete(auditLog).where(inArray(auditLog.userName, [PROBE, 'TEST_WS1T5 Admin']))
  })

  beforeEach(() => {
    role = 'pi'
    name = PROBE
    actingProvider = { id: providerId, name: 'Dr' }
  })

  it('fix round 1: linking a note follows the visit ownership rule (spec ruling 3)', async () => {
    const others = await create(PATIENT, { noteType: 'progress', encounterId: othersVisitId })
    expect(others.status).toBe(403)
    expect(await others.json()).toEqual({ error: 'Forbidden', code: 'not_owner' })
    const cancelled = await create(PATIENT, { noteType: 'progress', encounterId: cancelledVisitId })
    expect(cancelled.status).toBe(409)
    expect(await cancelled.json()).toEqual({ error: 'Visit is closed', code: 'visit_closed' })
    actingProvider = null // a pi with no linked doctor profile owns no visit
    expect((await create(PATIENT, { noteType: 'progress', encounterId })).status).toBe(403)
    actingProvider = { id: providerId, name: 'Dr' }
    expect((await newNote({ encounterId: completedVisitId })).encounterId).toBe(completedVisitId) // a late note is fine
    expect((await newNote({ encounterId })).encounterId).toBe(encounterId)
    role = 'admin'
    name = 'TEST_WS1T5 Admin'
    const admin = await create(PATIENT, { noteType: 'progress', encounterId: othersVisitId })
    expect(admin.status).toBe(201)
    noteIds.push((await admin.json()).id)
    expect(await getDb().select().from(encounterNotes).where(eq(encounterNotes.encounterId, cancelledVisitId))).toEqual([])
  })

  it('a note may link to a visit of the same patient, not another patient\'s visit', async () => {
    const linked = await newNote({ encounterId })
    expect(linked.encounterId).toBe(encounterId)
    const refused = await create(PATIENT, { noteType: 'progress', encounterId: otherEncounterId })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({ error: 'encounterId does not belong to this patient' })
    expect((await create(PATIENT, { noteType: 'progress', encounterId: 2147483000 })).status).toBe(400)
  })

  it('a body-less sign is 400 and leaves the note a draft', async () => {
    const note = await newNote()
    expect((await sign(note.id)).status).toBe(400)
    expect((await sign(note.id, { typedName: PROBE })).status).toBe(400)
    expect((await sign(note.id, { typedName: PROBE, attestation: false })).status).toBe(400)
    expect((await sign(note.id, { typedName: PROBE, attestation: true, extra: 1 })).status).toBe(400)
    expect((await getDb().select().from(encounterNotes).where(eq(encounterNotes.id, note.id)))[0].status).toBe('draft')
  })

  it('a typed name that is not the signer\'s own is 403 and writes nothing', async () => {
    const note = await newNote()
    const res = await sign(note.id, { typedName: 'Someone Else', attestation: true })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Typed name does not match' })
    expect(await signaturesOf(note.id)).toEqual([])
    expect((await getDb().select().from(encounterNotes).where(eq(encounterNotes.id, note.id)))[0].status).toBe('draft')
  })

  it('the author with their own name signs: 200, one encounter_note signature, then a second sign is 409', async () => {
    const note = await newNote({ encounterId })
    const res = await sign(note.id, { typedName: `  ${PROBE} `, attestation: true })
    expect(res.status).toBe(200)
    const rows = await signaturesOf(note.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ signableType: 'encounter_note', signableId: note.id, signerTypedName: PROBE, signerRole: 'pi', attestationText: NOTE_ATTESTATION })
    const [after] = await getDb().select().from(encounterNotes).where(eq(encounterNotes.id, note.id))
    expect(after.status).toBe('signed')
    expect(after.signedAt).not.toBeNull()

    const again = await sign(note.id, { typedName: PROBE, attestation: true })
    expect(again.status).toBe(409)
    expect(await signaturesOf(note.id)).toHaveLength(1)

    const audit = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE))
    expect(audit.map((r) => r.action)).toContain('signed encounter note')
    expect(JSON.stringify(audit)).not.toContain('SECRET-NOTE-TEXT')
  })

  it('another pi (own name) is 403 Only the author can sign; an admin may sign under any typed name', async () => {
    const note = await newNote()
    name = 'TEST_WS1T5 Other Doctor'
    const other = await sign(note.id, { typedName: 'TEST_WS1T5 Other Doctor', attestation: true })
    expect(other.status).toBe(403)
    expect(await other.json()).toEqual({ error: 'Only the author can sign' })
    role = 'admin'
    name = 'TEST_WS1T5 Admin'
    const admin = await sign(note.id, { typedName: 'Dr. Typed By Admin', attestation: true })
    expect(admin.status).toBe(200)
    expect((await signaturesOf(note.id))[0]).toMatchObject({ signerTypedName: 'Dr. Typed By Admin', signerRole: 'admin' })
  })

  it('a note signed through another patient\'s URL is 404', async () => {
    const note = await newNote()
    expect((await sign(note.id, { typedName: PROBE, attestation: true }, OTHER)).status).toBe(404)
    expect(await signaturesOf(note.id)).toEqual([])
  })
})
