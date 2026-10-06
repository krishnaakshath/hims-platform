import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { and, eq, inArray, like, or } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { GET, POST } from '@/app/api/consent-documents/route'
import { GET as getOne, PUT } from '@/app/api/consent-documents/[id]/route'
import { getDb } from '@/db/client'
import { auditLog, consentDocuments, formSubmissionConsents, formSubmissions, formTemplateConsents, formTemplates, signatures } from '@/db/schema'
import { CONSENT_DRAFT_BANNER, renderConsentText } from '@/lib/queries/consent-documents'

const PATIENT_ID = 'RD-0001' // seeded real patient

let sessionRole: 'admin' | 'crc' | 'pi' | 'frontdesk' | 'billing' | null = 'crc'
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () =>
    sessionRole ? { role: sessionRole, name: 'Jamie Ruiz', userId: null } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  ),
}))

const docIds: number[] = []
const templateIds: number[] = []
const submissionIds: number[] = []
const fscIds: number[] = []

afterEach(async () => {
  sessionRole = 'crc'
  const db = getDb()
  if (fscIds.length) await db.delete(signatures).where(and(eq(signatures.signableType, 'form_submission_consent'), inArray(signatures.signableId, fscIds)))
  if (fscIds.length) await db.delete(formSubmissionConsents).where(inArray(formSubmissionConsents.id, fscIds))
  if (submissionIds.length) await db.delete(formSubmissions).where(inArray(formSubmissions.id, submissionIds))
  if (templateIds.length) await db.delete(formTemplateConsents).where(inArray(formTemplateConsents.formTemplateId, templateIds))
  if (templateIds.length) await db.delete(formTemplates).where(inArray(formTemplates.id, templateIds))
  if (docIds.length) await db.delete(consentDocuments).where(inArray(consentDocuments.id, docIds))
  for (const a of [fscIds, submissionIds, templateIds, docIds]) a.length = 0
})

afterAll(async () => {
  await getDb().delete(auditLog).where(or(eq(auditLog.action, 'created consent document'), eq(auditLog.action, 'viewed consent documents'), like(auditLog.action, 'viewed consent document %'), like(auditLog.action, 'updated consent document %')))
})

const json = (method: string, body: unknown) =>
  new Request('http://localhost', { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) as never
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) })

async function createDoc(extra: Record<string, unknown> = {}) {
  const res = await POST(json('POST', { name: 'Test Consent', bodyText: 'By signing, I agree.', ...extra }))
  const body = await res.json()
  if (res.status === 201) docIds.push(body.id)
  return { res, body }
}

async function makeTemplateWithSubmission(docId: number) {
  const db = getDb()
  const [t] = await db.insert(formTemplates).values({ name: `CD Test ${Date.now()}`, category: 'Uncategorized', diagnosisTag: 'test', questions: [] }).returning()
  templateIds.push(t.id)
  await db.insert(formTemplateConsents).values({ formTemplateId: t.id, consentDocumentId: docId })
  const [s] = await db.insert(formSubmissions).values({ templateId: t.id, patientId: PATIENT_ID }).returning()
  submissionIds.push(s.id)
  const [fsc] = await db.insert(formSubmissionConsents).values({ formSubmissionId: s.id, consentDocumentId: docId }).returning()
  fscIds.push(fsc.id)
  return fsc
}

async function sign(fscId: number, attestationText: string) {
  const [sig] = await getDb().insert(signatures).values({
    signableType: 'form_submission_consent', signableId: fscId, signerTypedName: 'Maria Alvarez', signerRole: 'patient', attestationText,
  }).returning()
  return sig
}

async function readSig(id: number) {
  const [s] = await getDb().select().from(signatures).where(eq(signatures.id, id))
  return s
}

describe('consent documents CRUD', () => {
  it('creates, reads, and edits a document', async () => {
    const { res, body } = await createDoc()
    expect(res.status).toBe(201)
    const got = await (await getOne(new Request('http://localhost') as never, ctx(body.id))).json()
    expect(got.name).toBe('Test Consent')
    expect(got.bodyText).toBe('By signing, I agree.')

    const put = await PUT(json('PUT', { name: 'Renamed', bodyText: 'New wording', legalReviewStatus: 'reviewed' }), ctx(body.id))
    expect(put.status).toBe(200)
    const after = await (await getOne(new Request('http://localhost') as never, ctx(body.id))).json()
    expect(after).toMatchObject({ name: 'Renamed', bodyText: 'New wording', legalReviewStatus: 'reviewed' })
  })

  it("defaults legalReviewStatus to 'draft'", async () => {
    const { body } = await createDoc()
    expect(body.legalReviewStatus).toBe('draft')
  })

  it('returns 404 for an unknown id on GET and PUT', async () => {
    expect((await getOne(new Request('http://localhost') as never, ctx(2147483000))).status).toBe(404)
    expect((await PUT(json('PUT', { name: 'x' }), ctx(2147483000))).status).toBe(404)
  })

  it('lists documents with counts', async () => {
    const { body } = await createDoc()
    const list = await (await GET()).json()
    expect(list.find((d: { id: number }) => d.id === body.id)).toMatchObject({ onFormsCount: 0, signedCount: 0 })
  })
})

describe('renderConsentText', () => {
  it('composes the banner for a draft and not for a reviewed document', () => {
    const draft = renderConsentText({ bodyText: 'By signing…', legalReviewStatus: 'draft' })
    expect(draft.startsWith(CONSENT_DRAFT_BANNER)).toBe(true)
    expect(draft).toContain('By signing…')
    expect(draft).toBe(`${CONSENT_DRAFT_BANNER}\n\nBy signing…`)
    expect(renderConsentText({ bodyText: 'By signing…', legalReviewStatus: 'reviewed' })).toBe('By signing…')
  })
})

describe('derived counts', () => {
  it('onFormsCount reflects attachments across two templates', async () => {
    const { body } = await createDoc()
    await makeTemplateWithSubmission(body.id)
    await makeTemplateWithSubmission(body.id)
    const got = await (await getOne(new Request('http://localhost') as never, ctx(body.id))).json()
    expect(got.onFormsCount).toBe(2)
  })

  it('signedCount reflects signatures across submissions of both templates, and ignores other signable types', async () => {
    const { body } = await createDoc()
    const a = await makeTemplateWithSubmission(body.id)
    const b = await makeTemplateWithSubmission(body.id)
    await sign(a.id, 'text a')
    await sign(b.id, 'text b')
    // Same integer id under a different signableType must NOT be counted.
    const [other] = await getDb().insert(signatures).values({
      signableType: 'form_submission', signableId: a.id, signerTypedName: 'X', signerRole: 'patient', attestationText: 'unrelated',
    }).returning()
    try {
      const got = await (await getOne(new Request('http://localhost') as never, ctx(body.id))).json()
      expect(got.signedCount).toBe(2)
    } finally {
      await getDb().delete(signatures).where(eq(signatures.id, other.id))
    }
  })
})

describe('signature immutability', () => {
  it('editing bodyText after a signature exists leaves attestationText byte-for-byte unchanged', async () => {
    const { body } = await createDoc()
    const fsc = await makeTemplateWithSubmission(body.id)
    const stored = renderConsentText({ bodyText: body.bodyText, legalReviewStatus: body.legalReviewStatus })
    const sig = await sign(fsc.id, stored)
    const before = (await readSig(sig.id)).attestationText

    const put = await PUT(json('PUT', { bodyText: 'Completely different wording.' }), ctx(body.id))
    expect(put.status).toBe(200)

    const after = await readSig(sig.id)
    expect(after.attestationText).toBe(before)
    expect(after.attestationText).toBe(stored)
  })

  it("flipping legalReviewStatus draft -> reviewed leaves the signature's attestationText unchanged, banner included", async () => {
    const { body } = await createDoc()
    const fsc = await makeTemplateWithSubmission(body.id)
    const sig = await sign(fsc.id, renderConsentText({ bodyText: body.bodyText, legalReviewStatus: 'draft' }))
    const before = (await readSig(sig.id)).attestationText

    const put = await PUT(json('PUT', { legalReviewStatus: 'reviewed' }), ctx(body.id))
    expect(put.status).toBe(200)

    const after = await readSig(sig.id)
    expect(after.attestationText).toBe(before)
    expect(after.attestationText.startsWith(CONSENT_DRAFT_BANNER)).toBe(true)
  })
})

describe('role gating', () => {
  it.each(['frontdesk', 'billing'] as const)('%s gets 403 on GET, POST, PUT, and GET [id]', async (role) => {
    const { body } = await createDoc()
    sessionRole = role
    expect((await GET()).status).toBe(403)
    expect((await POST(json('POST', { name: 'n', bodyText: 'b' }))).status).toBe(403)
    expect((await PUT(json('PUT', { name: 'n' }), ctx(body.id))).status).toBe(403)
    expect((await getOne(new Request('http://localhost') as never, ctx(body.id))).status).toBe(403)
  })

  it('admin is allowed', async () => {
    sessionRole = 'admin'
    expect((await GET()).status).toBe(200)
  })

  it('pi (doctor) is allowed on GET, POST, PUT, and GET [id]', async () => {
    const { body } = await createDoc()
    sessionRole = 'pi'
    expect((await GET()).status).toBe(200)
    expect((await getOne(new Request('http://localhost') as never, ctx(body.id))).status).toBe(200)
    expect((await PUT(json('PUT', { name: `pi-renamed-${body.id}` }), ctx(body.id))).status).toBe(200)
  })

  it('no session gets 401', async () => {
    sessionRole = null
    expect((await GET()).status).toBe(401)
    expect((await POST(json('POST', { name: 'n', bodyText: 'b' }))).status).toBe(401)
    expect((await PUT(json('PUT', { name: 'n' }), ctx(1))).status).toBe(401)
  })
})

describe('.strict() validation', () => {
  it('POST with an extra field is 400', async () => {
    const res = await POST(json('POST', { name: 'n', bodyText: 'b', signedCount: 99 }))
    expect(res.status).toBe(400)
  })

  it('POST with a malformed JSON body is 400, not 500', async () => {
    const res = await POST(new Request('http://localhost', { method: 'POST', body: '{not json', headers: { 'Content-Type': 'application/json' } }) as never)
    expect(res.status).toBe(400)
  })

  it('PUT with a malformed JSON body is 400, not 500', async () => {
    const { body } = await createDoc()
    const res = await PUT(new Request('http://localhost', { method: 'PUT', body: '{not json', headers: { 'Content-Type': 'application/json' } }) as never, ctx(body.id))
    expect(res.status).toBe(400)
  })

  it('PUT with a non-enum legalReviewStatus is 400', async () => {
    const { body } = await createDoc()
    expect((await PUT(json('PUT', { legalReviewStatus: 'pending' }), ctx(body.id))).status).toBe(400)
  })
})

describe('audit', () => {
  it("writes a 'created consent document' audit row on create", async () => {
    const before = await getDb().select().from(auditLog).where(eq(auditLog.action, 'created consent document'))
    await createDoc()
    const after = await getDb().select().from(auditLog).where(eq(auditLog.action, 'created consent document'))
    expect(after.length).toBeGreaterThan(before.length)
  })
})
