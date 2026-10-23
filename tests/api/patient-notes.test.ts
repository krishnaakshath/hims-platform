import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { and, eq, inArray, or, ilike } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import { POST as createRoute } from '@/app/api/patients/[anonId]/notes/route'
import { PUT as signRoute } from '@/app/api/patients/[anonId]/notes/[id]/sign/route'
import { getDb } from '@/db/client'
import { patients, providers, rooms, admissions, appointments, encounterNotes, signatures, users, auditLog } from '@/db/schema'
import { hashPassword } from '@/lib/password'
import { encryptSensitive } from '@/lib/crypto'
import { SIGN_NOTE_ATTESTATION } from '@/lib/queries/encounter-notes'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' = 'pi'
let sessionName = 'Dr. R. Kunam'
let sessionUserId: number | null = null
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: sessionName, userId: sessionUserId })) }))

// WS7 T5: signing re-authenticates, so the signing tests need real users rows.
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const PASSWORD = `Note-Sign-${RUN}`
const TOTP_SECRET = new OTPAuth.Secret({ size: 20 }).base32
const createdUserIds: number[] = []
let passwordUserId = 0
let totpUserId = 0
let passwordHash = ''

beforeAll(async () => {
  passwordHash = hashPassword(PASSWORD)
  const [pw] = await getDb().insert(users).values({ name: 'Dr. R. Kunam', email: `note-sign-pw-${RUN}@test.local`, role: 'pi', passwordHash }).returning()
  const [totp] = await getDb().insert(users).values({ name: 'Dr. R. Kunam', email: `note-sign-totp-${RUN}@test.local`, role: 'pi', googleSub: `note-sign-${RUN}`, mfaSecretEncrypted: encryptSensitive(TOTP_SECRET), mfaEnabled: true }).returning()
  passwordUserId = pw.id
  totpUserId = totp.id
  createdUserIds.push(pw.id, totp.id)
  sessionUserId = passwordUserId
})

afterAll(async () => {
  if (createdUserIds.length > 0) await getDb().delete(users).where(inArray(users.id, createdUserIds))
})

const createdNoteIds: number[] = []
const createdAdmissionIds: number[] = []
const createdRoomIds: number[] = []
const createdAppointmentIds: number[] = []
afterEach(async () => {
  sessionRole = 'pi'
  sessionName = 'Dr. R. Kunam'
  sessionUserId = passwordUserId
  vi.restoreAllMocks()
  if (createdNoteIds.length > 0) await getDb().delete(signatures).where(and(eq(signatures.signableType, 'encounter_note'), inArray(signatures.signableId, createdNoteIds)))
  while (createdNoteIds.length > 0) await getDb().delete(encounterNotes).where(eq(encounterNotes.id, createdNoteIds.pop()!))
  while (createdAdmissionIds.length > 0) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
  while (createdAppointmentIds.length > 0) await getDb().delete(appointments).where(eq(appointments.id, createdAppointmentIds.pop()!))
})

function req(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
}

describe('POST /api/patients/[anonId]/notes', () => {
  it('creates a draft note', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const res = await createRoute(req({ noteType: 'progress', subjective: 'Test' }) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    createdNoteIds.push(body.id)
    expect(body.status).toBe('draft')
    expect(body.authorName).toBe('Dr. R. Kunam')
  })

  it('rejects both appointmentId and admissionId set at once', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const [admissionRow] = await getDb().select().from(admissions).limit(1)
    const res = await createRoute(req({ noteType: 'progress', appointmentId: 1, admissionId: admissionRow?.id ?? 1 }) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(400)
  })

  it('rejects a frontdesk session', async () => {
    sessionRole = 'frontdesk'
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const res = await createRoute(req({ noteType: 'progress' }) as never, { params: Promise.resolve({ anonId: patientRow.id }) })
    expect(res.status).toBe(403)
  })

  it('rejects an admissionId belonging to a different patient', async () => {
    const patientRows = await getDb().select().from(patients).limit(2)
    if (patientRows.length < 2) throw new Error('This test needs at least 2 seeded patients -- run npm run db:seed')
    const [patientA, patientB] = patientRows

    // A real admission that genuinely belongs to patientB, not patientA.
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: 'CP1', bedNumber: 'A' }).returning()
    createdRoomIds.push(room.id)
    const [providerRow] = await getDb().select().from(providers).limit(1)
    const [admissionForB] = await getDb().insert(admissions).values({ patientId: patientB.id, currentRoomId: room.id, attendingProviderId: providerRow.id }).returning()
    createdAdmissionIds.push(admissionForB.id)

    // Attempt to create a note for patientA that references patientB's admission.
    const res = await createRoute(req({ noteType: 'progress', admissionId: admissionForB.id }) as never, { params: Promise.resolve({ anonId: patientA.id }) })
    expect(res.status).toBe(400)
  })

  it('rejects an appointmentId belonging to a different patient', async () => {
    const patientRows = await getDb().select().from(patients).limit(2)
    if (patientRows.length < 2) throw new Error('This test needs at least 2 seeded patients -- run npm run db:seed')
    const [patientA, patientB] = patientRows

    // A real appointment that genuinely belongs to patientB, not patientA.
    const [providerRow] = await getDb().select().from(providers).limit(1)
    const [appointmentForB] = await getDb().insert(appointments).values({
      patientId: patientB.id,
      providerId: providerRow.id,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 30 * 60 * 1000),
      visitReason: 'Test visit',
    }).returning()
    createdAppointmentIds.push(appointmentForB.id)

    // Attempt to create a note for patientA that references patientB's appointment.
    const res = await createRoute(req({ noteType: 'progress', appointmentId: appointmentForB.id }) as never, { params: Promise.resolve({ anonId: patientA.id }) })
    expect(res.status).toBe(400)
  })
})

function signReq(body?: unknown) {
  return new Request('http://localhost', { method: 'PUT', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) })
}

async function draftNote(anonId: string): Promise<number> {
  const createRes = await createRoute(req({ noteType: 'progress' }) as never, { params: Promise.resolve({ anonId }) })
  const created = await createRes.json()
  createdNoteIds.push(created.id)
  return created.id
}

const sign = (anonId: string, noteId: number, body?: unknown) => signRoute(signReq(body) as never, { params: Promise.resolve({ anonId, id: String(noteId) }) })
const withPassword = (password = PASSWORD, typedName = 'Dr. R. Kunam') => ({ typedName, attested: true, password })
const noteSignatures = (noteId: number) => getDb().select().from(signatures).where(and(eq(signatures.signableType, 'encounter_note'), eq(signatures.signableId, noteId)))
const noteStatus = async (noteId: number) => (await getDb().select().from(encounterNotes).where(eq(encounterNotes.id, noteId)))[0].status

describe('PUT /api/patients/[anonId]/notes/[id]/sign', () => {
  it('signs a draft note with the correct password and writes one encounter_note signature', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const noteId = await draftNote(patientRow.id)

    const res = await sign(patientRow.id, noteId, withPassword())
    expect(res.status).toBe(200)
    expect(await noteStatus(noteId)).toBe('signed')
    const rows = await noteSignatures(noteId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ signableType: 'encounter_note', signerTypedName: 'Dr. R. Kunam', signerRole: 'pi', attestationText: SIGN_NOTE_ATTESTATION, patientId: patientRow.id })
    expect(SIGN_NOTE_ATTESTATION).toBe('I confirm I wrote or reviewed this note and that it is accurate.')
  })

  it('refuses a wrong password with 401 reauth_failed and leaves the note a draft', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const noteId = await draftNote(patientRow.id)

    const res = await sign(patientRow.id, noteId, withPassword('wrong-password'))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'reauth_failed' })
    expect(await noteStatus(noteId)).toBe('draft')
    expect(await noteSignatures(noteId)).toHaveLength(0)
  })

  it('signs with a current TOTP code for an account without a password (Google sign-in)', async () => {
    sessionUserId = totpUserId
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const noteId = await draftNote(patientRow.id)

    const totpCode = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: TOTP_SECRET }).generate()
    const res = await sign(patientRow.id, noteId, { typedName: 'Dr. R. Kunam', attested: true, totpCode })
    expect(res.status).toBe(200)
    expect(await noteSignatures(noteId)).toHaveLength(1)
  })

  it('signs as the env-configured admin against ADMIN_PASSWORD_HASH', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const noteId = await draftNote(patientRow.id)

    const previous = process.env.ADMIN_PASSWORD_HASH
    process.env.ADMIN_PASSWORD_HASH = passwordHash
    try {
      sessionRole = 'admin'
      sessionName = 'Test Admin'
      sessionUserId = null
      const res = await sign(patientRow.id, noteId, withPassword(PASSWORD, 'Test Admin'))
      expect(res.status).toBe(200)
      const rows = await noteSignatures(noteId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ signerTypedName: 'Test Admin', signerRole: 'admin' })
    } finally {
      if (previous === undefined) delete process.env.ADMIN_PASSWORD_HASH
      else process.env.ADMIN_PASSWORD_HASH = previous
    }
  })

  it('rate-limits the sixth wrong attempt in 15 minutes with 429', async () => {
    // A fresh account so the per-user bucket starts empty on every run.
    const [fresh] = await getDb().insert(users).values({ name: 'Dr. R. Kunam', email: `note-sign-rl-${RUN}@test.local`, role: 'pi', passwordHash }).returning()
    createdUserIds.push(fresh.id)
    sessionUserId = fresh.id
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const noteId = await draftNote(patientRow.id)

    for (let i = 0; i < 5; i++) {
      const res = await sign(patientRow.id, noteId, withPassword('wrong-password'))
      expect(res.status).toBe(401)
    }
    const sixth = await sign(patientRow.id, noteId, withPassword('wrong-password'))
    expect(sixth.status).toBe(429)
    // Even the right password is refused while the bucket is exhausted.
    const right = await sign(patientRow.id, noteId, withPassword())
    expect(right.status).toBe(429)
    expect(await noteStatus(noteId)).toBe('draft')
  })

  it('never writes the password to the console or to an audit row', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m))
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const noteId = await draftNote(patientRow.id)
    const wrongPassword = `Wrong-${RUN}`

    expect((await sign(patientRow.id, noteId, withPassword(wrongPassword))).status).toBe(401)
    expect((await sign(patientRow.id, noteId, withPassword())).status).toBe(200)

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const text = call.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' ')
        expect(text).not.toContain(PASSWORD)
        expect(text).not.toContain(wrongPassword)
      }
    }
    const leaked = await getDb().select({ id: auditLog.id }).from(auditLog).where(or(
      ilike(auditLog.action, `%${RUN}%`), ilike(auditLog.details, `%${RUN}%`),
    ))
    expect(leaked).toHaveLength(0)
  })

  it('refuses a typed name that is not the session user\'s own name, admins included', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const noteId = await draftNote(patientRow.id)

    expect((await sign(patientRow.id, noteId, withPassword(PASSWORD, 'Someone Else'))).status).toBe(403)

    sessionRole = 'admin'
    sessionName = 'Test Admin'
    sessionUserId = null
    expect((await sign(patientRow.id, noteId, withPassword(PASSWORD, 'Dr. R. Kunam'))).status).toBe(403)
    expect(await noteStatus(noteId)).toBe('draft')
  })

  it('requires a strict body: typed name, attested true, and exactly one of password or TOTP code', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const noteId = await draftNote(patientRow.id)

    for (const body of [
      undefined,
      { typedName: 'Dr. R. Kunam', attested: true },
      { typedName: 'Dr. R. Kunam', attested: false, password: PASSWORD },
      { typedName: 'Dr. R. Kunam', attested: true, password: PASSWORD, totpCode: '123456' },
      { typedName: 'Dr. R. Kunam', attested: true, totpCode: '12345' },
      { typedName: '', attested: true, password: PASSWORD },
      { typedName: 'Dr. R. Kunam', attested: true, password: PASSWORD, extra: 1 },
    ]) {
      const res = await sign(patientRow.id, noteId, body)
      expect(res.status).toBe(400)
    }
    expect(await noteStatus(noteId)).toBe('draft')
  })

  it('rejects signing by a different pi than the author', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const noteId = await draftNote(patientRow.id)

    sessionName = 'A Different Doctor'
    const signRes = await sign(patientRow.id, noteId, withPassword(PASSWORD, 'A Different Doctor'))
    expect(signRes.status).toBe(403)
  })

  it('rejects signing an already-signed note a second time and keeps one signature', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const noteId = await draftNote(patientRow.id)

    expect((await sign(patientRow.id, noteId, withPassword())).status).toBe(200)
    expect((await sign(patientRow.id, noteId, withPassword())).status).toBe(409)
    expect(await noteSignatures(noteId)).toHaveLength(1)
  })

  it('rejects signing a note through a different patient\'s URL than the one it belongs to', async () => {
    const patientRows = await getDb().select().from(patients).limit(2)
    if (patientRows.length < 2) throw new Error('This test needs at least 2 seeded patients -- run npm run db:seed')
    const [patientA, patientB] = patientRows

    // A real note that genuinely belongs to patientA, not patientB.
    const noteId = await draftNote(patientA.id)

    // Attempt to sign patientA's note via patientB's URL.
    const signRes = await sign(patientB.id, noteId, withPassword())
    expect(signRes.status).toBe(404)
    expect(await noteStatus(noteId)).toBe('draft')
  })
})
