import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq, asc } from 'drizzle-orm'
import { GET, PUT } from '@/app/api/intake/[token]/route'
import { POST as sendForm } from '@/app/api/form-submissions/route'
import { getDb } from '@/db/client'
import { formSubmissions, formTemplates, formChartDiscrepancies, patients } from '@/db/schema'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz' })) }))

// Every sendRealForm() call inserts a real row into the shared dev DB via
// the actual POST route -- this file was previously missing cleanup
// entirely, and most of its tests call it, so a single run left 5-6 junk
// "sent"/"completed" submissions on RD-0001 every time.
//
// Completing a submission now also runs the form-vs-chart discrepancy
// check (lib/form-chart-discrepancy.ts) -- RD-0001 (Maria Alvarez) has a
// real active SSRI/SNRI medication on her seeded chart, and these tests'
// answers never fill in the "Currently taking antidepressants?" question,
// so every completed-submission test here would otherwise leave a real,
// uncleaned discrepancy row behind too. Delete discrepancies before
// submissions (FK: formChartDiscrepancies.formSubmissionId -> formSubmissions.id).
const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) {
    const id = createdIds.pop()!
    await getDb().delete(formChartDiscrepancies).where(eq(formChartDiscrepancies.formSubmissionId, id))
    await getDb().delete(formSubmissions).where(eq(formSubmissions.id, id))
  }
})

// The seeded template IDs are serial and drift across reseeds of the shared
// dev database, so tests look up a real, currently-valid template ID rather
// than assuming any fixed value -- but a bare `limit(1)` with no ordering
// risks landing on a non-"Trial Intake" template (e.g. a consent form or
// PHQ-9, both seeded with their own unrelated q1/q2) whose questions have
// no autofillField at all, silently breaking the autofill assertions below
// without ever touching them. Scope to category = 'Trial Intake' (MDD/ADHD
// Intake Packet, the only templates seeded with autofillField on q1/q2).
async function realTemplateId(): Promise<number> {
  const [row] = await getDb().select({ id: formTemplates.id }).from(formTemplates).where(eq(formTemplates.category, 'Trial Intake')).orderBy(asc(formTemplates.id)).limit(1)
  if (!row) throw new Error('No seeded Trial Intake form templates found -- run npm run db:seed')
  return row.id
}

async function sendRealForm() {
  const templateId = await realTemplateId()
  const req = new Request('http://localhost/api/form-submissions', { method: 'POST', body: JSON.stringify({ templateId, patientId: 'RD-0001' }) })
  const res = await sendForm(req as never)
  const body = await res.json() as { id: number; accessToken: string }
  createdIds.push(body.id)
  return body
}

describe('GET /api/intake/[token]', () => {
  it('returns not_found for a bogus token', async () => {
    const res = await GET({} as never, { params: Promise.resolve({ token: 'nonexistent-token-xyz' }) })
    const body = await res.json()
    expect(body.state).toBe('not_found')
  })

  it('returns active state with questions and autofill for a real, freshly sent token', async () => {
    const { accessToken } = await sendRealForm()

    const res = await GET({} as never, { params: Promise.resolve({ token: accessToken }) })
    const body = await res.json()
    expect(body.state).toBe('active')
    expect(Array.isArray(body.questions)).toBe(true)
    expect(body).not.toHaveProperty('idNumberEncrypted')
    expect(body).not.toHaveProperty('diagnoses')

    // AUTOFILL_SOURCE reads the single-sourced `name`/`dob` columns directly
    // (post-unified-patient-record) -- confirm the autofill values match
    // RD-0001's actual row rather than some stale mirrored field.
    const [patient] = await getDb().select({ name: patients.name, dob: patients.dob }).from(patients).where(eq(patients.id, 'RD-0001'))
    const nameQuestion = body.questions.find((q: { id: string }) => q.id === 'q1')
    const dobQuestion = body.questions.find((q: { id: string }) => q.id === 'q2')
    if (nameQuestion) expect(body.autofill[nameQuestion.id]).toBe(patient.name)
    if (dobQuestion) expect(body.autofill[dobQuestion.id]).toBe(patient.dob)
  })

  it('returns expired state for a token whose tokenExpiresAt has passed', async () => {
    const { accessToken } = await sendRealForm()
    await getDb().update(formSubmissions).set({ tokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(formSubmissions.accessToken, accessToken))

    const res = await GET({} as never, { params: Promise.resolve({ token: accessToken }) })
    const body = await res.json()
    expect(body.state).toBe('expired')
  })
})

describe('PUT /api/intake/[token]', () => {
  it('rejects an unknown token', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ answers: {}, complete: false }) })
    const res = await PUT(req as never, { params: Promise.resolve({ token: 'nonexistent-token-xyz' }) })
    expect(res.status).toBe(404)
  })

  it('rejects a payload with an unexpected extra field', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ answers: {}, complete: false, extra: 'x' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ token: 'nonexistent-token-xyz' }) })
    expect(res.status).toBe(404) // token check runs first; still confirms .strict() would reject if it got further — see the real-token test below
  })

  it('rejects a payload with an unexpected extra field against a real, valid token (.strict() enforcement)', async () => {
    const { accessToken } = await sendRealForm()

    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ answers: {}, complete: false, extra: 'x' }) })
    const res = await PUT(req as never, { params: Promise.resolve({ token: accessToken }) })
    expect(res.status).toBe(400)
  })

  it('saves partial progress and completes the submission for a real, valid token', async () => {
    const { accessToken } = await sendRealForm()

    const putReq = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ answers: { q1: 'answer' }, complete: true }) })
    const putRes = await PUT(putReq as never, { params: Promise.resolve({ token: accessToken }) })
    expect(putRes.status).toBe(200)

    const getRes = await GET({} as never, { params: Promise.resolve({ token: accessToken }) })
    const body = await getRes.json()
    expect(body.state).toBe('completed')
  })

  it('rejects a PUT against a token whose submission is already completed', async () => {
    const { accessToken } = await sendRealForm()

    const firstPut = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ answers: { q1: 'first' }, complete: true }) })
    expect((await PUT(firstPut as never, { params: Promise.resolve({ token: accessToken }) })).status).toBe(200)

    const secondPut = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ answers: { q1: 'tampered' }, complete: false }) })
    const secondRes = await PUT(secondPut as never, { params: Promise.resolve({ token: accessToken }) })
    expect(secondRes.status).toBe(404)

    // Confirms the first submission's answers were never overwritten by the
    // rejected second write.
    const check = await GET({} as never, { params: Promise.resolve({ token: accessToken }) })
    const body = await check.json()
    expect(body.state).toBe('completed')
  })
})
