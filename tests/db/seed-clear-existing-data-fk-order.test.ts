import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  patients, formTemplates, formSubmissions, formSubmissionScores, formChartDiscrepancies,
  formTemplateFolders, consentDocuments, formTemplateConsents, formSubmissionConsents,
} from '@/db/schema'

// Proves, against the real Postgres FK constraints (not by eyeballing
// clearExistingData()'s statement ordering in src/db/seed.ts), that
// formSubmissionScores and formChartDiscrepancies must be deleted before
// formSubmissions -- exactly the "children before parents" fix applied to
// clearExistingData() for final review finding C2.
//
// This does NOT call clearExistingData() or seed() directly: both do
// unscoped full-table deletes across many tables in this shared dev
// database, which would be destructive to concurrently running worktrees.
// Instead, this test creates its own isolated rows and issues the same
// delete statements clearExistingData() issues, scoped to just those rows
// via WHERE, to exercise the identical FK constraints safely.

let templateId: number | undefined
let submissionId: number | undefined

afterEach(async () => {
  const db = getDb()
  if (submissionId != null) {
    await db.delete(formChartDiscrepancies).where(eq(formChartDiscrepancies.formSubmissionId, submissionId))
    await db.delete(formSubmissionScores).where(eq(formSubmissionScores.formSubmissionId, submissionId))
    await db.delete(formSubmissions).where(eq(formSubmissions.id, submissionId))
    submissionId = undefined
  }
  if (templateId != null) {
    await db.delete(formTemplates).where(eq(formTemplates.id, templateId))
    templateId = undefined
  }
})

async function makeSubmissionWithChildren() {
  const db = getDb()
  const [template] = await db.insert(formTemplates).values({
    name: `FK Order Test ${Date.now()}`, category: 'Screening Questionnaires', diagnosisTag: 'Test',
    questions: [{ id: 'q1', label: 'Q', type: 'select', options: ['A', 'B'], optionScores: [0, 5], hipaaSensitive: false, required: true }],
    scoringRule: { questionIds: ['q1'], bands: [{ min: 0, max: 5, label: 'High' }] },
  }).returning()
  templateId = template.id

  const [patientRow] = await db.select().from(patients).limit(1)
  const [submission] = await db.insert(formSubmissions).values({
    templateId: template.id, patientId: patientRow.id, status: 'completed', answers: { q1: 'B' },
  }).returning()
  submissionId = submission.id

  await db.insert(formSubmissionScores).values({ formSubmissionId: submission.id, totalScore: 5, bandLabel: 'High' })
  await db.insert(formChartDiscrepancies).values({
    patientId: patientRow.id, formSubmissionId: submission.id, questionId: 'q1', questionLabel: 'Q',
    patientAnswer: 'B', chartFinding: 'No matching chart entry',
  })

  return submission.id
}

// Postgres FK-violation SQL state (23503). Drizzle wraps the underlying pg
// error in `.cause`, so assertions must inspect the cause, not the
// top-level "Failed query: ..." message drizzle-orm raises.
async function expectForeignKeyViolation(promise: Promise<unknown>) {
  let caught: unknown
  try {
    await promise
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(Error)
  const cause = (caught as { cause?: { code?: string; message?: string } }).cause
  expect(cause?.code).toBe('23503')
  expect(cause?.message ?? '').toMatch(/foreign key/i)
}

describe('formSubmissions child-table FK ordering (final review C2)', () => {
  it('rejects deleting formSubmissions while a formSubmissionScores row still references it', async () => {
    const id = await makeSubmissionWithChildren()
    const db = getDb()
    // Deliberately delete the parent first, children still in place -- this
    // is the pre-fix bug's exact shape. Postgres must reject it.
    await expectForeignKeyViolation(db.delete(formSubmissions).where(eq(formSubmissions.id, id)))
  })

  it('rejects deleting formSubmissions while a formChartDiscrepancies row still references it', async () => {
    const id = await makeSubmissionWithChildren()
    const db = getDb()
    // Isolate this constraint: remove the scores row first so only the
    // discrepancies FK is under test.
    await db.delete(formSubmissionScores).where(eq(formSubmissionScores.formSubmissionId, id))
    await expectForeignKeyViolation(db.delete(formSubmissions).where(eq(formSubmissions.id, id)))
  })

  it('succeeds deleting formSubmissions after both child tables are cleared first, matching the fixed clearExistingData() ordering', async () => {
    const id = await makeSubmissionWithChildren()
    const db = getDb()
    // Exactly the fixed clearExistingData() ordering: formSubmissionScores
    // and formChartDiscrepancies before formSubmissions.
    await db.delete(formSubmissionScores).where(eq(formSubmissionScores.formSubmissionId, id))
    await db.delete(formChartDiscrepancies).where(eq(formChartDiscrepancies.formSubmissionId, id))
    await expect(db.delete(formSubmissions).where(eq(formSubmissions.id, id))).resolves.not.toThrow()

    const remaining = await db.select().from(formSubmissions).where(eq(formSubmissions.id, id))
    expect(remaining.length).toBe(0)
    submissionId = undefined // already deleted; afterEach only needs to clean up the template
  })
})

// Forms hub tables (final whole-branch review of feature/forms-redesign, I2).
// Same approach: isolated rows, scoped deletes in clearExistingData()'s
// order, never the real unscoped wipe. Plus a static check that
// clearExistingData()'s own statement order matches what these FK tests prove.
describe('forms hub join tables FK ordering (final review I2)', () => {
  const ids: { folder?: number; doc?: number; template?: number; submission?: number; ftc?: number; fsc?: number } = {}

  afterEach(async () => {
    const db = getDb()
    if (ids.fsc != null) await db.delete(formSubmissionConsents).where(eq(formSubmissionConsents.id, ids.fsc))
    if (ids.submission != null) await db.delete(formSubmissions).where(eq(formSubmissions.id, ids.submission))
    if (ids.ftc != null) await db.delete(formTemplateConsents).where(eq(formTemplateConsents.id, ids.ftc))
    if (ids.template != null) await db.delete(formTemplates).where(eq(formTemplates.id, ids.template))
    if (ids.folder != null) await db.delete(formTemplateFolders).where(eq(formTemplateFolders.id, ids.folder))
    if (ids.doc != null) await db.delete(consentDocuments).where(eq(consentDocuments.id, ids.doc))
    for (const k of Object.keys(ids) as (keyof typeof ids)[]) delete ids[k]
  })

  async function makeFixture() {
    const db = getDb()
    const tag = `FK Order Forms Hub ${Date.now()}`
    const [folder] = await db.insert(formTemplateFolders).values({ name: tag }).returning()
    ids.folder = folder.id
    const [doc] = await db.insert(consentDocuments).values({ name: tag, bodyText: 'x' }).returning()
    ids.doc = doc.id
    const [template] = await db.insert(formTemplates).values({ name: tag, category: 'Uncategorized', diagnosisTag: 'test', questions: [], folderId: folder.id }).returning()
    ids.template = template.id
    const [ftc] = await db.insert(formTemplateConsents).values({ formTemplateId: template.id, consentDocumentId: doc.id }).returning()
    ids.ftc = ftc.id
    const [patientRow] = await db.select().from(patients).limit(1)
    const [submission] = await db.insert(formSubmissions).values({ templateId: template.id, patientId: patientRow.id, status: 'sent' }).returning()
    ids.submission = submission.id
    const [fsc] = await db.insert(formSubmissionConsents).values({ formSubmissionId: submission.id, consentDocumentId: doc.id }).returning()
    ids.fsc = fsc.id
    return { folder, doc, template, ftc, submission, fsc }
  }

  it('rejects deleting formSubmissions while a formSubmissionConsents row references it', async () => {
    const f = await makeFixture()
    await expectForeignKeyViolation(getDb().delete(formSubmissions).where(eq(formSubmissions.id, f.submission.id)))
  })

  it('rejects deleting formTemplates while a formTemplateConsents row references it', async () => {
    const f = await makeFixture()
    const db = getDb()
    // Clear the submission side so only the template-consents FK is under test.
    await db.delete(formSubmissionConsents).where(eq(formSubmissionConsents.id, f.fsc.id)); ids.fsc = undefined
    await db.delete(formSubmissions).where(eq(formSubmissions.id, f.submission.id)); ids.submission = undefined
    await expectForeignKeyViolation(db.delete(formTemplates).where(eq(formTemplates.id, f.template.id)))
  })

  it('rejects deleting formTemplateFolders while a formTemplates row references it', async () => {
    const f = await makeFixture()
    await expectForeignKeyViolation(getDb().delete(formTemplateFolders).where(eq(formTemplateFolders.id, f.folder.id)))
  })

  it('rejects deleting consentDocuments while either join table references it', async () => {
    const f = await makeFixture()
    await expectForeignKeyViolation(getDb().delete(consentDocuments).where(eq(consentDocuments.id, f.doc.id)))
  })

  it("succeeds in clearExistingData()'s fixed order", async () => {
    const f = await makeFixture()
    const db = getDb()
    await db.delete(formSubmissionConsents).where(eq(formSubmissionConsents.id, f.fsc.id)); ids.fsc = undefined
    await db.delete(formSubmissions).where(eq(formSubmissions.id, f.submission.id)); ids.submission = undefined
    await db.delete(formTemplateConsents).where(eq(formTemplateConsents.id, f.ftc.id)); ids.ftc = undefined
    await db.delete(formTemplates).where(eq(formTemplates.id, f.template.id)); ids.template = undefined
    await db.delete(formTemplateFolders).where(eq(formTemplateFolders.id, f.folder.id)); ids.folder = undefined
    await db.delete(consentDocuments).where(eq(consentDocuments.id, f.doc.id)); ids.doc = undefined
    expect(await db.select().from(consentDocuments).where(eq(consentDocuments.id, f.doc.id))).toHaveLength(0)
  })

  it('clearExistingData() in src/db/seed.ts issues those deletes in that order', () => {
    const src = readFileSync(join(process.cwd(), 'src/db/seed.ts'), 'utf8')
    const body = src.slice(src.indexOf('async function clearExistingData()'), src.indexOf('export async function seed()'))
    const pos = (t: string) => {
      const i = body.indexOf(`await db.delete(${t})`)
      expect(i, t).toBeGreaterThanOrEqual(0)
      return i
    }
    expect(pos('formSubmissionConsents')).toBeLessThan(pos('formSubmissions'))
    expect(pos('formTemplateConsents')).toBeLessThan(pos('formTemplates'))
    expect(pos('formSubmissions')).toBeLessThan(pos('formTemplates'))
    expect(pos('formTemplates')).toBeLessThan(pos('formTemplateFolders'))
    expect(pos('formSubmissionConsents')).toBeLessThan(pos('consentDocuments'))
    expect(pos('formTemplateConsents')).toBeLessThan(pos('consentDocuments'))
  })
})
