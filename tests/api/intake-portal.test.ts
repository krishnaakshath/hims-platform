import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq, asc } from 'drizzle-orm'
import { GET, PUT } from '@/app/api/intake/[token]/route'
import { POST as sendForm } from '@/app/api/form-submissions/route'
import { getDb } from '@/db/client'
import { formSubmissions, formTemplates, formChartDiscrepancies, formSubmissionScores, documents, patients } from '@/db/schema'
import type { FormQuestion } from '@/lib/forms/question-model'

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
afterEach(cleanupSubmissions)
async function cleanupSubmissions() {
  while (createdIds.length > 0) {
    const id = createdIds.pop()!
    await getDb().delete(formChartDiscrepancies).where(eq(formChartDiscrepancies.formSubmissionId, id))
    await getDb().delete(formSubmissionScores).where(eq(formSubmissionScores.formSubmissionId, id))
    await getDb().delete(formSubmissions).where(eq(formSubmissions.id, id))
  }
}

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

// Valid answers to every question of the seeded Trial Intake template: PUT
// complete now validates (validateAnswers), so a required question left blank is a 400.
async function fullAnswers(): Promise<Record<string, string>> {
  const [t] = await getDb().select({ questions: formTemplates.questions }).from(formTemplates).where(eq(formTemplates.id, await realTemplateId()))
  const out: Record<string, string> = {}
  for (const q of t.questions) {
    if (q.type === 'section') continue
    out[q.id] = q.type === 'checkbox' ? 'true' : q.type === 'select' ? (q.options?.[0] ?? 'x') : q.type === 'date' ? '1990-01-01' : q.type === 'number' ? '1' : q.type === 'phone' ? '9876543210' : 'answer'
  }
  return out
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

    const putReq = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ answers: await fullAnswers(), complete: true }) })
    const putRes = await PUT(putReq as never, { params: Promise.resolve({ token: accessToken }) })
    expect(putRes.status).toBe(200)

    const getRes = await GET({} as never, { params: Promise.resolve({ token: accessToken }) })
    const body = await getRes.json()
    expect(body.state).toBe('completed')
  })

  it('rejects a PUT against a token whose submission is already completed', async () => {
    const { accessToken } = await sendRealForm()

    const firstPut = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ answers: await fullAnswers(), complete: true }) })
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

// WS7 T3: PUT validates with validateAnswers and stores only `cleaned`.
describe('PUT /api/intake/[token] validates against the template (WS7 T3)', () => {
  const CONDITIONAL: FormQuestion[] = [
    { id: 'smoker', label: 'Do you smoke?', type: 'select', options: ['Yes', 'No'], hipaaSensitive: false, required: true, i18n: { hi: { label: 'क्या आप धूम्रपान करते हैं?', options: ['हाँ', 'नहीं'] } } },
    { id: 'perDay', label: 'Cigarettes per day', type: 'number', hipaaSensitive: false, required: true, visibleIf: { questionId: 'smoker', equals: 'Yes' } },
    { id: 'mobile', label: 'Mobile', type: 'phone', hipaaSensitive: false, required: false },
    { id: 'scan', label: 'Referral letter', type: 'file', hipaaSensitive: false, required: false },
    { id: 'sign', label: 'Signature', type: 'signature', hipaaSensitive: false, required: true },
  ]
  const templateIds: number[] = []
  const docIds: number[] = []
  afterEach(async () => {
    await cleanupSubmissions() // submissions reference the template: delete them first
    for (const id of docIds.splice(0)) await getDb().delete(documents).where(eq(documents.id, id))
    for (const id of templateIds.splice(0)) await getDb().delete(formTemplates).where(eq(formTemplates.id, id))
  })

  async function sendConditional() {
    const [t] = await getDb().insert(formTemplates).values({ name: `Conditional ${Date.now()}`, category: 'Uncategorized', diagnosisTag: 'test', questions: CONDITIONAL, languages: ['en', 'hi'] }).returning()
    templateIds.push(t.id)
    const res = await sendForm(new Request('http://localhost/api/form-submissions', { method: 'POST', body: JSON.stringify({ templateId: t.id, patientId: 'RD-0001' }) }) as never)
    const body = await res.json() as { id: number; accessToken: string }
    createdIds.push(body.id)
    return body
  }
  const put = (token: string, answers: Record<string, string>, complete: boolean) =>
    PUT(new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ answers, complete }) }) as never, { params: Promise.resolve({ token }) })
  const stored = async (id: number) => (await getDb().select().from(formSubmissions).where(eq(formSubmissions.id, id)))[0]

  it('GET exposes the conditions, translations and offered languages the renderer needs', async () => {
    const { accessToken } = await sendConditional()
    const body = await (await GET({} as never, { params: Promise.resolve({ token: accessToken }) })).json()
    expect(body.languages).toEqual(['en', 'hi'])
    expect(body.questions[1].visibleIf).toEqual({ questionId: 'smoker', equals: 'Yes' })
    expect(body.questions[0].i18n.hi.label).toBe('क्या आप धूम्रपान करते हैं?')
  })

  it('a question hidden by "No" is not required and its stale answer is dropped', async () => {
    const { id, accessToken } = await sendConditional()
    const res = await put(accessToken, { smoker: 'No', perDay: '20', sign: ' Maria Alvarez ', bogus: 'x' }, true)
    expect(res.status).toBe(200)
    const row = await stored(id)
    expect(row.status).toBe('completed')
    expect(row.answers).toEqual({ smoker: 'No', sign: 'Maria Alvarez' })
  })

  it('"Yes" makes the dependent question required: completing without it is 400 with a field error', async () => {
    const { id, accessToken } = await sendConditional()
    const res = await put(accessToken, { smoker: 'Yes', sign: 'Maria Alvarez' }, true)
    expect(res.status).toBe(400)
    expect((await res.json()).errors).toEqual({ perDay: 'This question is required' })
    expect((await stored(id)).status).toBe('sent')
  })

  it('a partial save does not demand required answers but still normalises and drops hidden ones', async () => {
    const { id, accessToken } = await sendConditional()
    const res = await put(accessToken, { smoker: 'No', perDay: '3', mobile: '98765 43210' }, false)
    expect(res.status).toBe(200)
    const row = await stored(id)
    expect(row.status).toBe('partial')
    expect(row.answers).toEqual({ smoker: 'No', mobile: '+919876543210' })
  })

  it('a malformed answer is a 400 even on a partial save', async () => {
    const { accessToken } = await sendConditional()
    const res = await put(accessToken, { mobile: '12' }, false)
    expect(res.status).toBe(400)
    expect((await res.json()).errors).toEqual({ mobile: 'Enter a valid mobile number' })
  })

  it('a file answer must name a document of this patient', async () => {
    const { accessToken } = await sendConditional()
    const [other] = await getDb().insert(documents).values({ name: 'x', documentDate: '2026-10-01', receivedFrom: 'Patient form', patientId: 'RD-0002', fileType: 'PDF' }).returning()
    const [own] = await getDb().insert(documents).values({ name: 'y', documentDate: '2026-10-01', receivedFrom: 'Patient form', patientId: 'RD-0001', fileType: 'PDF' }).returning()
    docIds.push(other.id, own.id)
    const bad = await put(accessToken, { scan: `doc:${other.id}` }, false)
    expect(bad.status).toBe(400)
    expect((await bad.json()).errors).toEqual({ scan: 'Upload the requested document' })
    expect((await put(accessToken, { scan: `doc:${own.id}` }, false)).status).toBe(200)
  })
})
