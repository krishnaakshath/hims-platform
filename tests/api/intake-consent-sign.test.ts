import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { and, eq, inArray, gte } from 'drizzle-orm'
import { GET, PUT } from '@/app/api/intake/[token]/route'
import { POST as sendForm } from '@/app/api/form-submissions/route'
import { POST as signConsent } from '@/app/api/intake/[token]/consents/[formSubmissionConsentId]/sign/route'
import { PUT as updateDoc } from '@/app/api/consent-documents/[id]/route'
import { PUT as staffUpdateSubmission } from '@/app/api/form-submissions/[id]/route'
import { getDb } from '@/db/client'
import {
  auditLog, consentDocuments, formChartDiscrepancies, formSubmissionConsents, formSubmissionScores,
  formSubmissions, formTemplateConsents, formTemplates, signatures,
} from '@/db/schema'
import { CONSENT_DRAFT_BANNER } from '@/lib/queries/consent-documents'

// Only the staff-side send (POST /api/form-submissions) and the staff-side
// consent-document edit consult this mock. The intake GET/PUT and the inline
// sign route never call requireSession() -- they are token-authorized.
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz', userId: null })) }))

const PATIENT_ID = 'RD-0001' // seeded real patient
const SIGN_ACTION = 'signed consent document via intake form'
const suiteStart = new Date()

const docIds: number[] = []
const templateIds: number[] = []
const submissionIds: number[] = []

afterEach(async () => {
  const db = getDb()
  if (submissionIds.length) {
    const fscRows = await db.select({ id: formSubmissionConsents.id }).from(formSubmissionConsents).where(inArray(formSubmissionConsents.formSubmissionId, submissionIds))
    const fscIds = fscRows.map((r) => r.id)
    if (fscIds.length) {
      await db.delete(signatures).where(and(eq(signatures.signableType, 'form_submission_consent'), inArray(signatures.signableId, fscIds)))
      await db.delete(formSubmissionConsents).where(inArray(formSubmissionConsents.id, fscIds))
    }
    await db.delete(formChartDiscrepancies).where(inArray(formChartDiscrepancies.formSubmissionId, submissionIds))
    await db.delete(formSubmissionScores).where(inArray(formSubmissionScores.formSubmissionId, submissionIds))
    await db.delete(formSubmissions).where(inArray(formSubmissions.id, submissionIds))
  }
  if (templateIds.length) {
    await db.delete(formTemplateConsents).where(inArray(formTemplateConsents.formTemplateId, templateIds))
    await db.delete(formTemplates).where(inArray(formTemplates.id, templateIds))
  }
  if (docIds.length) {
    for (const id of docIds) await db.delete(auditLog).where(eq(auditLog.action, `updated consent document ${id}`))
    await db.delete(consentDocuments).where(inArray(consentDocuments.id, docIds))
  }
  for (const a of [submissionIds, templateIds, docIds]) a.length = 0
})

afterAll(async () => {
  // SIGN_ACTION is written only by this feature's route; scoped to this
  // run's window and patient so a concurrent writer's rows are untouched.
  await getDb().delete(auditLog).where(and(eq(auditLog.action, SIGN_ACTION), eq(auditLog.patientId, PATIENT_ID), gte(auditLog.timestamp, suiteStart)))
})

async function makeDoc(bodyText: string, legalReviewStatus: 'draft' | 'reviewed' = 'draft') {
  const [doc] = await getDb().insert(consentDocuments).values({ name: `Intake Sign Test ${Date.now()}`, bodyText, legalReviewStatus }).returning()
  docIds.push(doc.id)
  return doc
}

async function makeTemplate(attach: { docId: number; sortOrder: number }[] = []) {
  const db = getDb()
  const [t] = await db.insert(formTemplates).values({
    name: `Intake Sign Test ${Date.now()}`, category: 'Uncategorized', diagnosisTag: 'test', questions: [],
  }).returning()
  templateIds.push(t.id)
  for (const a of attach) await db.insert(formTemplateConsents).values({ formTemplateId: t.id, consentDocumentId: a.docId, sortOrder: a.sortOrder })
  return t
}

// Calls the real staff-side send route so send-time row creation is exercised.
async function sendRealForm(templateId: number) {
  const req = new Request('http://localhost/api/form-submissions', { method: 'POST', body: JSON.stringify({ templateId, patientId: PATIENT_ID }) })
  const res = await sendForm(req as never)
  expect(res.status).toBe(201)
  const body = await res.json() as { id: number; accessToken: string }
  submissionIds.push(body.id)
  return body
}

async function fscRowsFor(submissionId: number) {
  return getDb().select().from(formSubmissionConsents).where(eq(formSubmissionConsents.formSubmissionId, submissionId)).orderBy(formSubmissionConsents.sortOrder)
}

async function sigsFor(fscId: number) {
  return getDb().select().from(signatures).where(and(eq(signatures.signableType, 'form_submission_consent'), eq(signatures.signableId, fscId)))
}

function sign(token: string, fscId: number, body: unknown = { typedName: 'Maria Alvarez' }) {
  const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
  return signConsent(req as never, { params: Promise.resolve({ token, formSubmissionConsentId: String(fscId) }) })
}

function put(token: string, body: unknown) {
  const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
  return PUT(req as never, { params: Promise.resolve({ token }) })
}

async function getIntake(token: string) {
  const res = await GET({} as never, { params: Promise.resolve({ token }) })
  return res.json()
}

async function statusOf(submissionId: number) {
  const [row] = await getDb().select({ status: formSubmissions.status, answers: formSubmissions.answers }).from(formSubmissions).where(eq(formSubmissions.id, submissionId))
  return row
}

describe('send-time consent rows', () => {
  it('sending a form with attached consents creates the matching formSubmissionConsents rows, sortOrder preserved', async () => {
    const a = await makeDoc('Doc A body')
    const b = await makeDoc('Doc B body')
    const t = await makeTemplate([{ docId: a.id, sortOrder: 5 }, { docId: b.id, sortOrder: 2 }])
    const { id } = await sendRealForm(t.id)

    const rows = await fscRowsFor(id)
    expect(rows.map((r) => [r.consentDocumentId, r.sortOrder])).toEqual([[b.id, 2], [a.id, 5]])

    const data = await getIntake((await getDb().select({ t: formSubmissions.accessToken }).from(formSubmissions).where(eq(formSubmissions.id, id)))[0].t!)
    expect(data.consents.map((c: { formSubmissionConsentId: number }) => c.formSubmissionConsentId)).toEqual(rows.map((r) => r.id))
    expect(data.consents[0].renderedText).toBe(`${CONSENT_DRAFT_BANNER}\n\nDoc B body`)
    expect(data.consents[0].signedAt).toBeNull()
  })

  it('a template with no attached consents produces no rows and GET returns consents: []', async () => {
    const t = await makeTemplate()
    const { id, accessToken } = await sendRealForm(t.id)
    expect(await fscRowsFor(id)).toHaveLength(0)
    const data = await getIntake(accessToken)
    expect(data.state).toBe('active')
    expect(data.consents ?? []).toEqual([])
  })
})

describe('POST /api/intake/[token]/consents/[id]/sign', () => {
  it('inserts a form_submission_consent signature as the patient; draft attestation carries the banner', async () => {
    const doc = await makeDoc('I consent to the study.')
    const t = await makeTemplate([{ docId: doc.id, sortOrder: 0 }])
    const { id, accessToken } = await sendRealForm(t.id)
    const [fsc] = await fscRowsFor(id)

    const res = await sign(accessToken, fsc.id)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const sigs = await sigsFor(fsc.id)
    expect(sigs).toHaveLength(1)
    expect(sigs[0].signableType).toBe('form_submission_consent')
    expect(sigs[0].signableId).toBe(fsc.id)
    expect(sigs[0].signerRole).toBe('patient')
    expect(sigs[0].signerTypedName).toBe('Maria Alvarez')
    expect(sigs[0].attestationText.startsWith(CONSENT_DRAFT_BANNER)).toBe(true)

    const [audit] = await getDb().select().from(auditLog)
      .where(and(eq(auditLog.action, SIGN_ACTION), eq(auditLog.patientId, PATIENT_ID), gte(auditLog.timestamp, new Date(sigs[0].signedAt.getTime() - 60_000))))
    expect(audit).toBeDefined()
    expect(audit.userName).toBe('Patient (self-service)')

    const data = await getIntake(accessToken)
    expect(data.consents[0].signerTypedName).toBe('Maria Alvarez')
    expect(data.consents[0].signedAt).not.toBeNull()
  })

  it('a reviewed document attests to exactly its bodyText, no banner', async () => {
    const doc = await makeDoc('Reviewed wording.', 'reviewed')
    const t = await makeTemplate([{ docId: doc.id, sortOrder: 0 }])
    const { id, accessToken } = await sendRealForm(t.id)
    const [fsc] = await fscRowsFor(id)
    expect((await sign(accessToken, fsc.id)).status).toBe(200)
    const [sig] = await sigsFor(fsc.id)
    expect(sig.attestationText).toBe(doc.bodyText)
  })

  it('signing the same row twice returns 409 and leaves exactly one signature', async () => {
    const doc = await makeDoc('Twice.')
    const t = await makeTemplate([{ docId: doc.id, sortOrder: 0 }])
    const { id, accessToken } = await sendRealForm(t.id)
    const [fsc] = await fscRowsFor(id)
    expect((await sign(accessToken, fsc.id)).status).toBe(200)
    const second = await sign(accessToken, fsc.id)
    expect(second.status).toBe(409)
    expect((await second.json()).error).toBe('This consent has already been signed')
    expect(await sigsFor(fsc.id)).toHaveLength(1)
  })

  it("a valid token for form A cannot sign a consent belonging to form B", async () => {
    const doc = await makeDoc('Cross.')
    const t = await makeTemplate([{ docId: doc.id, sortOrder: 0 }])
    const formA = await sendRealForm(t.id)
    const formB = await sendRealForm(t.id)
    const [fscA] = await fscRowsFor(formA.id)
    const [fscB] = await fscRowsFor(formB.id)

    const res = await sign(formA.accessToken, fscB.id)
    expect(res.status).toBe(404)
    expect(await sigsFor(fscA.id)).toHaveLength(0)
    expect(await sigsFor(fscB.id)).toHaveLength(0)
  })

  it('an unknown token -> 404', async () => {
    const doc = await makeDoc('Unknown.')
    const t = await makeTemplate([{ docId: doc.id, sortOrder: 0 }])
    const { id } = await sendRealForm(t.id)
    const [fsc] = await fscRowsFor(id)
    expect((await sign('nonexistent-token-xyz', fsc.id)).status).toBe(404)
    expect((await sign('nonexistent-token-xyz', Number.NaN)).status).toBe(404)
    expect(await sigsFor(fsc.id)).toHaveLength(0)
  })

  it('an expired or already-completed submission token -> 404', async () => {
    const doc = await makeDoc('Expired.')
    const t = await makeTemplate([{ docId: doc.id, sortOrder: 0 }])
    const expired = await sendRealForm(t.id)
    const completed = await sendRealForm(t.id)
    await getDb().update(formSubmissions).set({ tokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(formSubmissions.id, expired.id))
    await getDb().update(formSubmissions).set({ status: 'completed', completedDate: new Date() }).where(eq(formSubmissions.id, completed.id))
    const [fscE] = await fscRowsFor(expired.id)
    const [fscC] = await fscRowsFor(completed.id)

    expect((await sign(expired.accessToken, fscE.id)).status).toBe(404)
    expect((await sign(completed.accessToken, fscC.id)).status).toBe(404)
    expect(await sigsFor(fscE.id)).toHaveLength(0)
    expect(await sigsFor(fscC.id)).toHaveLength(0)
  })

  it.each([
    ['attestationText', { typedName: 'Maria Alvarez', attestationText: 'I agree to nothing' }],
    ['consentDocumentId', { typedName: 'Maria Alvarez', consentDocumentId: 1 }],
    ['signerRole', { typedName: 'Maria Alvarez', signerRole: 'admin' }],
    ['signedAt', { typedName: 'Maria Alvarez', signedAt: '2020-01-01T00:00:00Z' }],
    ['blank typedName', { typedName: '   ' }],
    ['missing typedName', {}],
    ['typedName over 200 chars', { typedName: 'a'.repeat(201) }],
  ])('the body is { typedName } only -- extra/invalid %s -> 400 and no signature', async (_label, body) => {
    const doc = await makeDoc('Strict.')
    const t = await makeTemplate([{ docId: doc.id, sortOrder: 0 }])
    const { id, accessToken } = await sendRealForm(t.id)
    const [fsc] = await fscRowsFor(id)
    expect((await sign(accessToken, fsc.id, body)).status).toBe(400)
    expect(await sigsFor(fsc.id)).toHaveLength(0)
  })
})

// Review Focus #5, end-to-end through the real inline sign path: the stored
// attestation is the verbatim string at signing time and nothing done to the
// consent document afterwards may reach back into it.
describe('stored signature immutability', () => {
  it('flipping draft->reviewed and editing bodyText do not change a stored attestationText; a draft-era signature keeps the banner forever', async () => {
    const original = 'Original draft wording.'
    const doc = await makeDoc(original, 'draft')
    const t = await makeTemplate([{ docId: doc.id, sortOrder: 0 }])
    const { id, accessToken } = await sendRealForm(t.id)
    const [fsc] = await fscRowsFor(id)

    expect((await sign(accessToken, fsc.id)).status).toBe(200)
    const [before] = await sigsFor(fsc.id)
    const expected = `${CONSENT_DRAFT_BANNER}\n\n${original}`
    expect(before.attestationText).toBe(expected)

    const docCtx = { params: Promise.resolve({ id: String(doc.id) }) }
    const flip = await updateDoc(new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ legalReviewStatus: 'reviewed' }) }) as never, docCtx)
    expect(flip.status).toBe(200)
    const [afterFlip] = await sigsFor(fsc.id)
    expect(afterFlip.attestationText).toBe(expected)

    const edit = await updateDoc(new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ bodyText: 'Completely new wording.' }) }) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(edit.status).toBe(200)
    const [afterEdit] = await getDb().select().from(consentDocuments).where(eq(consentDocuments.id, doc.id))
    expect(afterEdit.legalReviewStatus).toBe('reviewed')
    expect(afterEdit.bodyText).toBe('Completely new wording.')

    const sigs = await sigsFor(fsc.id)
    expect(sigs).toHaveLength(1)
    expect(sigs[0].id).toBe(before.id)
    expect(sigs[0].attestationText).toBe(expected)
    expect(sigs[0].attestationText.startsWith(CONSENT_DRAFT_BANNER)).toBe(true)
    expect(sigs[0].signedAt.getTime()).toBe(before.signedAt.getTime())

    // The patient's view of an already-signed consent is what they signed,
    // not the document's current wording.
    const data = await getIntake(accessToken)
    expect(data.consents[0].renderedText).toBe(expected)
  })
})

describe('PUT /api/intake/[token] completion gate', () => {
  it('rejects complete: true while any consent is unsigned; partial save is unaffected; succeeds once all signed', async () => {
    const a = await makeDoc('Gate A')
    const b = await makeDoc('Gate B')
    const t = await makeTemplate([{ docId: a.id, sortOrder: 0 }, { docId: b.id, sortOrder: 1 }])
    const { id, accessToken } = await sendRealForm(t.id)
    const [fscA, fscB] = await fscRowsFor(id)

    const blocked = await put(accessToken, { answers: { q1: 'x' }, complete: true })
    expect(blocked.status).toBe(400)
    expect((await blocked.json()).error).toBe('This form has unsigned consent documents')
    expect((await statusOf(id)).status).not.toBe('completed')

    const partial = await put(accessToken, { answers: { q1: 'saved' }, complete: false })
    expect(partial.status).toBe(200)
    const afterPartial = await statusOf(id)
    expect(afterPartial.status).toBe('partial')
    expect(afterPartial.answers).toEqual({ q1: 'saved' })
    expect(await sigsFor(fscA.id)).toHaveLength(0)

    expect((await sign(accessToken, fscA.id)).status).toBe(200)
    const stillBlocked = await put(accessToken, { answers: { q1: 'saved' }, complete: true })
    expect(stillBlocked.status).toBe(400)
    expect((await statusOf(id)).status).toBe('partial')

    expect((await sign(accessToken, fscB.id)).status).toBe(200)
    const ok = await put(accessToken, { answers: { q1: 'saved' }, complete: true })
    expect(ok.status).toBe(200)
    expect((await statusOf(id)).status).toBe('completed')
  })

  it('a submission with no attached consents completes exactly as it does today', async () => {
    const t = await makeTemplate()
    const { id, accessToken } = await sendRealForm(t.id)
    const res = await put(accessToken, { answers: { q1: 'answer' }, complete: true })
    expect(res.status).toBe(200)
    expect((await statusOf(id)).status).toBe('completed')
  })

  it('a consent-only packet (zero questions) is completable once signed', async () => {
    const doc = await makeDoc('Consent only.')
    const t = await makeTemplate([{ docId: doc.id, sortOrder: 0 }])
    const { id, accessToken } = await sendRealForm(t.id)

    const data = await getIntake(accessToken)
    expect(data.state).toBe('active')
    expect(data.questions).toEqual([])
    expect(data.consents).toHaveLength(1)

    const blocked = await put(accessToken, { answers: {}, complete: true })
    expect(blocked.status).toBe(400)
    expect((await statusOf(id)).status).not.toBe('completed')

    expect((await sign(accessToken, data.consents[0].formSubmissionConsentId)).status).toBe(200)
    const ok = await put(accessToken, { answers: {}, complete: true })
    expect(ok.status).toBe(200)
    expect((await statusOf(id)).status).toBe('completed')
  })
})

// Final whole-branch review I3: the staff-side PUT must not be a way around
// the intake completion gate.
describe('PUT /api/form-submissions/[id] unsigned-consent completion gate', () => {
  function staffPut(submissionId: number, body: unknown) {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
    return staffUpdateSubmission(req as never, { params: Promise.resolve({ id: String(submissionId) }) })
  }

  it('blocks completed while an attached consent is unsigned, allows it once signed', async () => {
    const doc = await makeDoc('Staff gate.')
    const t = await makeTemplate([{ docId: doc.id, sortOrder: 0 }])
    const { id, accessToken } = await sendRealForm(t.id)
    const [fsc] = await fscRowsFor(id)

    const blocked = await staffPut(id, { status: 'completed' })
    expect(blocked.status).toBe(400)
    expect((await blocked.json()).error).toBe('This form has unsigned consent documents')
    expect((await statusOf(id)).status).toBe('sent')

    // Non-completing status changes are unaffected.
    expect((await staffPut(id, { status: 'partial' })).status).toBe(200)

    expect((await sign(accessToken, fsc.id)).status).toBe(200)
    const ok = await staffPut(id, { status: 'completed' })
    expect(ok.status).toBe(200)
    expect((await statusOf(id)).status).toBe('completed')
  })

  it('a submission with no consent rows completes as before', async () => {
    const t = await makeTemplate()
    const { id } = await sendRealForm(t.id)
    const res = await staffPut(id, { status: 'completed' })
    expect(res.status).toBe(200)
    expect((await statusOf(id)).status).toBe('completed')
  })
})
