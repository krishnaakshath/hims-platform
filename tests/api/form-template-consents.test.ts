import { describe, it, expect, vi, afterEach } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { GET, POST } from '@/app/api/form-templates/[id]/consents/route'
import { DELETE } from '@/app/api/form-templates/[id]/consents/[consentDocumentId]/route'
import { getDb } from '@/db/client'
import { auditLog, consentDocuments, formSubmissionConsents, formSubmissions, formTemplateConsents, formTemplates, signatures } from '@/db/schema'

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
  if (templateIds.length) {
    await db.delete(auditLog).where(inArray(auditLog.action, templateIds.flatMap((t) => [
      `attached consent document to form template ${t}`,
      `detached consent document from form template ${t}`,
    ])))
    await db.delete(formTemplates).where(inArray(formTemplates.id, templateIds))
  }
  if (docIds.length) await db.delete(consentDocuments).where(inArray(consentDocuments.id, docIds))
  for (const a of [fscIds, submissionIds, templateIds, docIds]) a.length = 0
})

const json = (method: string, body: unknown) =>
  new Request('http://localhost', { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) as never
const bare = () => new Request('http://localhost') as never
const listCtx = (t: number) => ({ params: Promise.resolve({ id: String(t) }) })
const itemCtx = (t: number, d: number) => ({ params: Promise.resolve({ id: String(t), consentDocumentId: String(d) }) })

async function makeTemplate() {
  const [t] = await getDb().insert(formTemplates).values({ name: `FTC Test ${Date.now()}-${Math.random()}`, category: 'Uncategorized', diagnosisTag: 'test', questions: [] }).returning()
  templateIds.push(t.id)
  return t.id
}
async function makeDoc(status: 'draft' | 'reviewed' = 'draft') {
  const [d] = await getDb().insert(consentDocuments).values({ name: 'FTC Consent', bodyText: `${'x'.repeat(100)}\nsecond line`, legalReviewStatus: status }).returning()
  docIds.push(d.id)
  return d.id
}
async function list(t: number) {
  const res = await GET(bare(), listCtx(t))
  return { res, rows: await res.json() }
}
async function submissionWithConsent(templateId: number, docId: number) {
  const db = getDb()
  const [s] = await db.insert(formSubmissions).values({ templateId, patientId: PATIENT_ID }).returning()
  submissionIds.push(s.id)
  const [fsc] = await db.insert(formSubmissionConsents).values({ formSubmissionId: s.id, consentDocumentId: docId }).returning()
  fscIds.push(fsc.id)
  return fsc
}
async function sign(fscId: number, attestationText = 'I agree to the verbatim text') {
  const [sig] = await getDb().insert(signatures).values({
    signableType: 'form_submission_consent', signableId: fscId, signerTypedName: 'Maria Alvarez', signerRole: 'patient', attestationText,
  }).returning()
  return sig
}
const auditCount = async (action: string) => (await getDb().select().from(auditLog).where(eq(auditLog.action, action))).length

describe('attach / detach consent documents', () => {
  it('attaches and lists with name, status, preview, and signedCount 0', async () => {
    const t = await makeTemplate()
    const d = await makeDoc()
    const res = await POST(json('POST', { consentDocumentId: d }), listCtx(t))
    expect(res.status).toBe(201)
    expect(typeof (await res.json()).formTemplateConsentId).toBe('number')
    const { rows } = await list(t)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ consentDocumentId: d, name: 'FTC Consent', legalReviewStatus: 'draft', signedCount: 0, sortOrder: 0 })
    expect(rows[0].bodyPreview).toBe('x'.repeat(80))
  })

  it('preserves attachment order via sortOrder', async () => {
    const t = await makeTemplate()
    const a = await makeDoc()
    const b = await makeDoc()
    await POST(json('POST', { consentDocumentId: b }), listCtx(t))
    await POST(json('POST', { consentDocumentId: a }), listCtx(t))
    const { rows } = await list(t)
    expect(rows.map((r: { consentDocumentId: number }) => r.consentDocumentId)).toEqual([b, a])
    expect(rows.map((r: { sortOrder: number }) => r.sortOrder)).toEqual([0, 1])
  })

  it('detaches', async () => {
    const t = await makeTemplate()
    const d = await makeDoc()
    await POST(json('POST', { consentDocumentId: d }), listCtx(t))
    const res = await DELETE(bare(), itemCtx(t, d))
    expect(res.status).toBe(200)
    expect((await list(t)).rows).toEqual([])
    expect((await DELETE(bare(), itemCtx(t, d))).status).toBe(404)
  })

  it('rejects attaching the same document twice with 409', async () => {
    const t = await makeTemplate()
    const d = await makeDoc()
    expect((await POST(json('POST', { consentDocumentId: d }), listCtx(t))).status).toBe(201)
    expect((await POST(json('POST', { consentDocumentId: d }), listCtx(t))).status).toBe(409)
    expect((await list(t)).rows).toHaveLength(1)
  })

  it('maps a lost race on the unique index to 409, not 500', async () => {
    const t = await makeTemplate()
    const d = await makeDoc()
    const results = await Promise.all([1, 2, 3].map(() => POST(json('POST', { consentDocumentId: d }), listCtx(t))))
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([201, 409, 409])
    expect((await list(t)).rows).toHaveLength(1)
  })

  it('400 for a nonexistent consent document, nothing inserted', async () => {
    const t = await makeTemplate()
    const res = await POST(json('POST', { consentDocumentId: 2147483000 }), listCtx(t))
    expect(res.status).toBe(400)
    expect((await list(t)).rows).toEqual([])
  })

  it('404 for a nonexistent template', async () => {
    const d = await makeDoc()
    const res = await POST(json('POST', { consentDocumentId: d }), listCtx(2147483000))
    expect(res.status).toBe(404)
    const rows = await getDb().select().from(formTemplateConsents).where(eq(formTemplateConsents.consentDocumentId, d))
    expect(rows).toEqual([])
  })

  it('400 for a malformed JSON body', async () => {
    const t = await makeTemplate()
    const res = await POST(new Request('http://localhost', { method: 'POST', body: '{not json', headers: { 'Content-Type': 'application/json' } }) as never, listCtx(t))
    expect(res.status).toBe(400)
  })

  it('sortOrder does not collide after detaching a middle document and attaching another', async () => {
    const t = await makeTemplate()
    const a = await makeDoc()
    const b = await makeDoc()
    const c = await makeDoc()
    await POST(json('POST', { consentDocumentId: a }), listCtx(t))
    await POST(json('POST', { consentDocumentId: b }), listCtx(t))
    await DELETE(bare(), itemCtx(t, a))
    await POST(json('POST', { consentDocumentId: c }), listCtx(t))
    const orders = (await list(t)).rows.map((r: { sortOrder: number }) => r.sortOrder)
    expect(new Set(orders).size).toBe(orders.length)
  })

  it('rejects unknown fields (.strict())', async () => {
    const t = await makeTemplate()
    const d = await makeDoc()
    const res = await POST(json('POST', { consentDocumentId: d, sortOrder: 3 }), listCtx(t))
    expect(res.status).toBe(400)
    expect((await list(t)).rows).toEqual([])
  })
})

describe('detach with existing signatures', () => {
  it('leaves formSubmissionConsents and signatures intact', async () => {
    const t = await makeTemplate()
    const d = await makeDoc()
    await POST(json('POST', { consentDocumentId: d }), listCtx(t))
    const fsc = await submissionWithConsent(t, d)
    const sig = await sign(fsc.id, 'exact attested wording')

    expect((await DELETE(bare(), itemCtx(t, d))).status).toBe(200)

    const [fscAfter] = await getDb().select().from(formSubmissionConsents).where(eq(formSubmissionConsents.id, fsc.id))
    expect(fscAfter).toBeDefined()
    const [sigAfter] = await getDb().select().from(signatures).where(eq(signatures.id, sig.id))
    expect(sigAfter.attestationText).toBe('exact attested wording')
  })

  it('signedCount is per template', async () => {
    const t = await makeTemplate()
    const other = await makeTemplate()
    const d = await makeDoc()
    await POST(json('POST', { consentDocumentId: d }), listCtx(t))
    await POST(json('POST', { consentDocumentId: d }), listCtx(other))
    // signature against a DIFFERENT template's submission of the same document
    await sign((await submissionWithConsent(other, d)).id)
    expect((await list(t)).rows[0].signedCount).toBe(0)
    expect((await list(other)).rows[0].signedCount).toBe(1)

    await sign((await submissionWithConsent(t, d)).id)
    expect((await list(t)).rows[0].signedCount).toBe(1)

    // detach then re-attach: signature still counted
    await DELETE(bare(), itemCtx(t, d))
    await POST(json('POST', { consentDocumentId: d }), listCtx(t))
    expect((await list(t)).rows[0].signedCount).toBe(1)
  })
})

describe('role gating', () => {
  it.each(['frontdesk', 'billing'] as const)('%s gets 403 on GET, POST, DELETE', async (role) => {
    const t = await makeTemplate()
    const d = await makeDoc()
    sessionRole = role
    expect((await GET(bare(), listCtx(t))).status).toBe(403)
    expect((await POST(json('POST', { consentDocumentId: d }), listCtx(t))).status).toBe(403)
    expect((await DELETE(bare(), itemCtx(t, d))).status).toBe(403)
    sessionRole = 'crc'
    expect((await list(t)).rows).toEqual([])
  })

  it('no session gets 401 on all three', async () => {
    const t = await makeTemplate()
    const d = await makeDoc()
    sessionRole = null
    expect((await GET(bare(), listCtx(t))).status).toBe(401)
    expect((await POST(json('POST', { consentDocumentId: d }), listCtx(t))).status).toBe(401)
    expect((await DELETE(bare(), itemCtx(t, d))).status).toBe(401)
  })

  it('admin is allowed', async () => {
    const t = await makeTemplate()
    const d = await makeDoc()
    sessionRole = 'admin'
    expect((await POST(json('POST', { consentDocumentId: d }), listCtx(t))).status).toBe(201)
  })

  it('pi (doctor) is allowed on GET, POST, DELETE', async () => {
    const t = await makeTemplate()
    const d = await makeDoc()
    sessionRole = 'pi'
    expect((await POST(json('POST', { consentDocumentId: d }), listCtx(t))).status).toBe(201)
    expect((await GET(bare(), listCtx(t))).status).toBe(200)
    expect((await DELETE(bare(), itemCtx(t, d))).status).toBe(200)
  })
})

describe('audit', () => {
  it('writes exact attach and detach actions', async () => {
    const t = await makeTemplate()
    const d = await makeDoc()
    await POST(json('POST', { consentDocumentId: d }), listCtx(t))
    expect(await auditCount(`attached consent document to form template ${t}`)).toBe(1)
    await DELETE(bare(), itemCtx(t, d))
    expect(await auditCount(`detached consent document from form template ${t}`)).toBe(1)
  })
})
