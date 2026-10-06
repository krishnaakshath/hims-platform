import { describe, it, expect, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { formTemplates, formSubmissions, signatures, formTemplateFolders, consentDocuments, formTemplateConsents, formSubmissionConsents } from '@/db/schema'

const PATIENT_ID = 'RD-0001'
const createdSigIds: number[] = []
const createdSubConsentIds: number[] = []
const createdTplConsentIds: number[] = []
const createdSubmissionIds: number[] = []
const createdTemplateIds: number[] = []
const createdDocIds: number[] = []
const createdFolderIds: number[] = []

afterEach(async () => {
  const db = getDb()
  while (createdSigIds.length) await db.delete(signatures).where(eq(signatures.id, createdSigIds.pop()!))
  while (createdSubConsentIds.length) await db.delete(formSubmissionConsents).where(eq(formSubmissionConsents.id, createdSubConsentIds.pop()!))
  while (createdTplConsentIds.length) await db.delete(formTemplateConsents).where(eq(formTemplateConsents.id, createdTplConsentIds.pop()!))
  while (createdSubmissionIds.length) await db.delete(formSubmissions).where(eq(formSubmissions.id, createdSubmissionIds.pop()!))
  while (createdTemplateIds.length) await db.delete(formTemplates).where(eq(formTemplates.id, createdTemplateIds.pop()!))
  while (createdDocIds.length) await db.delete(consentDocuments).where(eq(consentDocuments.id, createdDocIds.pop()!))
  while (createdFolderIds.length) await db.delete(formTemplateFolders).where(eq(formTemplateFolders.id, createdFolderIds.pop()!))
})

describe('forms hub and embedded consents schema', () => {
  it('creates a folder with a default sortOrder of 0', async () => {
    const [folder] = await getDb().insert(formTemplateFolders).values({ name: 'Research Forms' }).returning()
    createdFolderIds.push(folder.id)
    expect(folder.sortOrder).toBe(0)
    expect(folder.createdAt).toBeInstanceOf(Date)
  })

  it('files a template into a folder and accepts folderId null', async () => {
    const db = getDb()
    const [folder] = await db.insert(formTemplateFolders).values({ name: 'Intake' }).returning()
    createdFolderIds.push(folder.id)
    const [filed] = await db.insert(formTemplates).values({ name: `T ${Date.now()}`, category: 'Uncategorized', diagnosisTag: 'General', questions: [], folderId: folder.id }).returning()
    createdTemplateIds.push(filed.id)
    expect(filed.folderId).toBe(folder.id)
    const [unfiled] = await db.insert(formTemplates).values({ name: `U ${Date.now()}`, category: 'Uncategorized', diagnosisTag: 'General', questions: [] }).returning()
    createdTemplateIds.push(unfiled.id)
    expect(unfiled.folderId).toBeNull()
  })

  it('defaults a consent document to legalReviewStatus draft', async () => {
    const [doc] = await getDb().insert(consentDocuments).values({ name: 'Telehealth Consent', bodyText: 'By signing below...' }).returning()
    createdDocIds.push(doc.id)
    expect(doc.legalReviewStatus).toBe('draft')
    expect(doc.updatedAt).toBeInstanceOf(Date)
  })

  it('rejects attaching the same consent document to the same template twice', async () => {
    const db = getDb()
    const [tpl] = await db.insert(formTemplates).values({ name: `T ${Date.now()}`, category: 'Uncategorized', diagnosisTag: 'General', questions: [] }).returning()
    createdTemplateIds.push(tpl.id)
    const [doc] = await db.insert(consentDocuments).values({ name: 'Dup probe', bodyText: 'x' }).returning()
    createdDocIds.push(doc.id)
    const [first] = await db.insert(formTemplateConsents).values({ formTemplateId: tpl.id, consentDocumentId: doc.id }).returning()
    createdTplConsentIds.push(first.id)
    await expect(db.insert(formTemplateConsents).values({ formTemplateId: tpl.id, consentDocumentId: doc.id })).rejects.toThrow()
  })

  it('stores a signature with signableType form_submission_consent pointing at a formSubmissionConsents id', async () => {
    const db = getDb()
    const [tpl] = await db.insert(formTemplates).values({ name: `T ${Date.now()}`, category: 'Uncategorized', diagnosisTag: 'General', questions: [] }).returning()
    createdTemplateIds.push(tpl.id)
    const [doc] = await db.insert(consentDocuments).values({ name: 'Sig probe', bodyText: 'x' }).returning()
    createdDocIds.push(doc.id)
    const [sub] = await db.insert(formSubmissions).values({ templateId: tpl.id, patientId: PATIENT_ID }).returning()
    createdSubmissionIds.push(sub.id)
    const [sc] = await db.insert(formSubmissionConsents).values({ formSubmissionId: sub.id, consentDocumentId: doc.id }).returning()
    createdSubConsentIds.push(sc.id)
    const [sig] = await db.insert(signatures).values({ signableType: 'form_submission_consent', signableId: sc.id, signerTypedName: 'Maria Alvarez', signerRole: 'patient', attestationText: 'x' }).returning()
    createdSigIds.push(sig.id)
    expect(sig.signableType).toBe('form_submission_consent')

    const found = await db.select().from(signatures).where(and(eq(signatures.signableType, 'form_submission_consent'), eq(signatures.signableId, sc.id)))
    expect(found).toHaveLength(1)
  })
})
