import { describe, it, expect, vi, afterEach } from 'vitest'
import { inArray } from 'drizzle-orm'
import { GET, POST } from '@/app/api/messages/[patientId]/route'
import { getDb } from '@/db/client'
import { messages } from '@/db/schema'
import * as auth from '@/lib/auth'
import * as patientSession from '@/lib/patient-session'
import { sendMessage } from '@/lib/queries/messages'

const STAFF_PATIENT_ID = 'RD-0001' // seeded real patient (Maria Alvarez)
const OTHER_PATIENT_ID = 'RD-0002' // a different seeded patient

// This route reads sessions directly with getSession()/getPatientSession()
// (not the require* helpers) so it can branch on which kind of session, if
// any, is present -- mock both to null by default and override per test.
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, getSession: vi.fn(async () => null) }
})
vi.mock('@/lib/patient-session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/patient-session')>('@/lib/patient-session')
  return { ...actual, getPatientSession: vi.fn(async () => null) }
})

function req(body?: unknown) {
  return new Request(`http://localhost/api/messages/${STAFF_PATIENT_ID}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })
}

// Every successful POST inserts a real row into the shared dev DB -- track
// and delete every one this file creates, same pattern as
// tests/api/form-submissions.test.ts.
const createdIds: number[] = []
afterEach(async () => {
  vi.mocked(auth.getSession).mockReset()
  vi.mocked(auth.getSession).mockResolvedValue(null)
  vi.mocked(patientSession.getPatientSession).mockReset()
  vi.mocked(patientSession.getPatientSession).mockResolvedValue(null)
  if (createdIds.length > 0) {
    await getDb().delete(messages).where(inArray(messages.id, createdIds))
    createdIds.length = 0
  }
})

describe('GET /api/messages/[patientId]', () => {
  it('returns 401 when neither a staff nor a patient session is present', async () => {
    const res = await GET(req() as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    expect(res.status).toBe(401)
  })

  // messages/page.tsx (LeftNav.tsx:81) -- crc/pi/admin/pharmacy, not
  // frontdesk/billing/labs. Enforced here too since this route is reachable
  // directly regardless of what the UI shows.
  it('does not treat a frontdesk session as a valid staff actor', async () => {
    vi.mocked(auth.getSession).mockResolvedValue({ role: 'frontdesk', name: 'Test Frontdesk', userId: null })
    const res = await GET(req() as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    expect(res.status).toBe(401)
  })

  it('returns 403 when a patient session tries to read a different patient\'s thread', async () => {
    vi.mocked(patientSession.getPatientSession).mockResolvedValue({ patientId: OTHER_PATIENT_ID })
    const res = await GET(req() as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    expect(res.status).toBe(403)
  })

  it('allows a patient session to read its own thread', async () => {
    vi.mocked(patientSession.getPatientSession).mockResolvedValue({ patientId: STAFF_PATIENT_ID })
    const res = await GET(req() as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })

  it('allows any staff session to read a patient\'s thread', async () => {
    vi.mocked(auth.getSession).mockResolvedValue({ role: 'crc', name: 'Jamie Ruiz', userId: null })
    const res = await GET(req() as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    expect(res.status).toBe(200)
  })

  it('prefers a staff session over a patient session when both are somehow present', async () => {
    vi.mocked(auth.getSession).mockResolvedValue({ role: 'admin', name: 'Test Admin', userId: null })
    vi.mocked(patientSession.getPatientSession).mockResolvedValue({ patientId: OTHER_PATIENT_ID })
    // A patient session for OTHER_PATIENT_ID would normally 403 against
    // STAFF_PATIENT_ID's thread -- staff wins the branch, so this succeeds.
    const res = await GET(req() as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    expect(res.status).toBe(200)
  })

  it('excludes another patient\'s message content from a staff GET of this patient\'s thread', async () => {
    const ownMessage = await sendMessage(STAFF_PATIENT_ID, 'patient', 'Maria Alvarez', 'Only for my thread, patient A')
    createdIds.push(ownMessage.id)
    const otherMessage = await sendMessage(OTHER_PATIENT_ID, 'patient', 'Test Patient B', 'Should never appear in patient A\'s thread')
    createdIds.push(otherMessage.id)

    vi.mocked(auth.getSession).mockResolvedValue({ role: 'crc', name: 'Jamie Ruiz', userId: null })
    const res = await GET(req() as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    const body = await res.json()
    const bodyText = JSON.stringify(body)

    expect(res.status).toBe(200)
    expect(body.some((m: { id: number }) => m.id === ownMessage.id)).toBe(true)
    expect(bodyText).toContain('Only for my thread, patient A')
    expect(body.some((m: { id: number }) => m.id === otherMessage.id)).toBe(false)
    expect(bodyText).not.toContain('Should never appear in patient A\'s thread')
  })

  it('marks provider-authored messages read once a patient session reads the thread', async () => {
    vi.mocked(auth.getSession).mockResolvedValue({ role: 'pi', name: 'Dr. Rajiv Kunam', userId: null })
    const sendRes = await POST(req({ body: 'Please remember to take your medication with food.' }) as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    const sent = await sendRes.json()
    createdIds.push(sent.id)
    expect(sent.readByPatientAt).toBeNull()

    vi.mocked(auth.getSession).mockResolvedValue(null)
    vi.mocked(patientSession.getPatientSession).mockResolvedValue({ patientId: STAFF_PATIENT_ID })
    await GET(req() as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })

    const [row] = await getDb().select().from(messages).where(inArray(messages.id, [sent.id]))
    expect(row.readByPatientAt).not.toBeNull()
  })
})

describe('POST /api/messages/[patientId]', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await POST(req({ body: 'hello' }) as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    expect(res.status).toBe(401)
  })

  it('rejects a patient session sending into another patient\'s thread', async () => {
    vi.mocked(patientSession.getPatientSession).mockResolvedValue({ patientId: OTHER_PATIENT_ID })
    const res = await POST(req({ body: 'hello' }) as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    expect(res.status).toBe(403)
  })

  it('rejects an empty body', async () => {
    vi.mocked(auth.getSession).mockResolvedValue({ role: 'crc', name: 'Jamie Ruiz', userId: null })
    const res = await POST(req({ body: '' }) as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    expect(res.status).toBe(400)
  })

  it('rejects a payload with an unexpected extra field (mass-assignment guard)', async () => {
    vi.mocked(auth.getSession).mockResolvedValue({ role: 'crc', name: 'Jamie Ruiz', userId: null })
    const res = await POST(req({ body: 'hello', senderRole: 'provider' }) as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    expect(res.status).toBe(400)
  })

  it('lets any staff role (not just pi) send as the provider', async () => {
    vi.mocked(auth.getSession).mockResolvedValue({ role: 'admin', name: 'Test Admin', userId: null })
    const res = await POST(req({ body: 'Your next appointment is confirmed.' }) as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    const body = await res.json()
    createdIds.push(body.id)
    expect(res.status).toBe(201)
    expect(body.senderRole).toBe('provider')
    expect(body.senderName).toBe('Test Admin')
  })

  it('lets a patient send into their own thread, attributed to their own name', async () => {
    vi.mocked(patientSession.getPatientSession).mockResolvedValue({ patientId: STAFF_PATIENT_ID })
    const res = await POST(req({ body: 'I have a question about my dosage.' }) as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    const body = await res.json()
    createdIds.push(body.id)
    expect(res.status).toBe(201)
    expect(body.senderRole).toBe('patient')
    expect(typeof body.senderName).toBe('string')
    expect(body.senderName.length).toBeGreaterThan(0)
  })

  it('attributes to the patient, not staff, when both sessions are present and the patient portal composer asserts actingAs: patient', async () => {
    // Regression test: a browser holding both cookies at once (e.g. staff
    // testing the patient portal in the same browser -- exactly how this
    // was found) used to always attribute to the staff session regardless
    // of which UI actually sent the request. MessageComposer now sends
    // `actingAs` based on which surface it renders in.
    vi.mocked(auth.getSession).mockResolvedValue({ role: 'admin', name: 'Test Admin', userId: null })
    vi.mocked(patientSession.getPatientSession).mockResolvedValue({ patientId: STAFF_PATIENT_ID })
    const res = await POST(req({ body: 'Sent from the patient portal composer.', actingAs: 'patient' }) as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    const body = await res.json()
    createdIds.push(body.id)
    expect(res.status).toBe(201)
    expect(body.senderRole).toBe('patient')
    expect(body.senderName).not.toBe('Test Admin')
  })

  it('still prefers staff by default when actingAs is omitted and both sessions are present', async () => {
    vi.mocked(auth.getSession).mockResolvedValue({ role: 'admin', name: 'Test Admin', userId: null })
    vi.mocked(patientSession.getPatientSession).mockResolvedValue({ patientId: STAFF_PATIENT_ID })
    const res = await POST(req({ body: 'Sent from the staff inbox composer.' }) as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    const body = await res.json()
    createdIds.push(body.id)
    expect(res.status).toBe(201)
    expect(body.senderRole).toBe('provider')
    expect(body.senderName).toBe('Test Admin')
  })

  it('rejects actingAs: patient for a patient session that does not match this thread\'s patientId', async () => {
    vi.mocked(auth.getSession).mockResolvedValue({ role: 'admin', name: 'Test Admin', userId: null })
    vi.mocked(patientSession.getPatientSession).mockResolvedValue({ patientId: OTHER_PATIENT_ID })
    // actingAs: 'patient' is only a hint -- it must still be a real,
    // matching patient session, so this falls through to the staff session
    // rather than being honored for a mismatched patientId.
    const res = await POST(req({ body: 'hello', actingAs: 'patient' }) as never, { params: Promise.resolve({ patientId: STAFF_PATIENT_ID }) })
    const body = await res.json()
    createdIds.push(body.id)
    expect(res.status).toBe(201)
    expect(body.senderRole).toBe('provider')
  })
})
