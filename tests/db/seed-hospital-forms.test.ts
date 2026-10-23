import { describe, it, expect } from 'vitest'
import { eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { consentDocuments, formTemplateConsents, formTemplates } from '@/db/schema'
import { HOSPITAL_FORM_PACK, seedHospitalForms } from '@/db/seed-hospital-forms'
import { formQuestionSchema, formTemplateBodySchema } from '@/lib/forms/question-model'

const DRAFT = '[DRAFT TRANSLATION]'
const form = (key: (typeof HOSPITAL_FORM_PACK)[number]['key']) => HOSPITAL_FORM_PACK.find((f) => f.key === key)!

class Rollback extends Error {}

// Runs `fn` inside a transaction that is always rolled back, with any pack
// templates / consent documents already in the database renamed out of the way
// first, so the seed sees an empty pack and nothing the test does persists.
async function inScratchTransaction(fn: (tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]) => Promise<void>) {
  try {
    await getDb().transaction(async (tx) => {
      const names = HOSPITAL_FORM_PACK.map((f) => f.name)
      const consentNames = HOSPITAL_FORM_PACK.flatMap((f) => f.consents.map((c) => c.name))
      await tx.update(formTemplates).set({ name: sql`${formTemplates.name} || ' (pre-existing)'` }).where(inArray(formTemplates.name, names))
      if (consentNames.length) await tx.update(consentDocuments).set({ name: sql`${consentDocuments.name} || ' (pre-existing)'` }).where(inArray(consentDocuments.name, consentNames))
      await fn(tx)
      throw new Rollback()
    })
  } catch (e) {
    if (!(e instanceof Rollback)) throw e
  }
}

describe('HOSPITAL_FORM_PACK content', () => {
  it('has the six hospital forms, each offered in English, Hindi and Kannada', () => {
    expect(HOSPITAL_FORM_PACK.map((f) => f.key)).toEqual([
      'general_consent', 'surgical_anaesthesia_consent', 'admission_form', 'discharge_consent', 'mlc_intimation', 'vaccination_record',
    ])
    expect(new Set(HOSPITAL_FORM_PACK.map((f) => f.name)).size).toBe(6)
  })

  it('every question validates with formQuestionSchema and every template with the template body rules', () => {
    for (const f of HOSPITAL_FORM_PACK) {
      for (const q of f.questions) {
        const r = formQuestionSchema.safeParse(q)
        expect(r.success, `${f.key}.${q.id}: ${r.success ? '' : JSON.stringify(r.error.issues)}`).toBe(true)
      }
      const body = formTemplateBodySchema.safeParse({ name: f.name, category: f.category, diagnosisTag: 'General', questions: f.questions, languages: ['en', 'hi', 'kn'] })
      expect(body.success, `${f.key}: ${body.success ? '' : JSON.stringify(body.error.issues)}`).toBe(true)
    }
  })

  it('translates every label into Hindi and Kannada', () => {
    for (const f of HOSPITAL_FORM_PACK) {
      for (const q of f.questions) {
        expect(q.i18n?.hi?.label?.trim(), `${f.key}.${q.id} hi`).toBeTruthy()
        expect(q.i18n?.kn?.label?.trim(), `${f.key}.${q.id} kn`).toBeTruthy()
        expect(/[ऀ-ॿ]/.test(q.i18n!.hi!.label!), `${f.key}.${q.id} hi script`).toBe(true)
        expect(/[ಀ-೿]/.test(q.i18n!.kn!.label!), `${f.key}.${q.id} kn script`).toBe(true)
      }
    }
  })

  it('marks every Hindi and Kannada consent body as a draft translation', () => {
    const consents = HOSPITAL_FORM_PACK.flatMap((f) => f.consents)
    expect(consents.length).toBeGreaterThan(0)
    for (const c of consents) {
      expect(c.translations.hi?.startsWith(DRAFT)).toBe(true)
      expect(c.translations.kn?.startsWith(DRAFT)).toBe(true)
    }
  })

  it('attaches consent documents to each consent-category form', () => {
    for (const f of HOSPITAL_FORM_PACK.filter((x) => x.category === 'Consent Forms')) expect(f.consents.length, f.key).toBeGreaterThan(0)
    expect(form('general_consent').category).toBe('Consent Forms')
    expect(form('surgical_anaesthesia_consent').category).toBe('Consent Forms')
    expect(form('discharge_consent').category).toBe('Consent Forms')
    expect(form('admission_form').category).toBe('Admission')
    expect(form('mlc_intimation').category).toBe('Medico-legal')
    expect(form('vaccination_record').category).toBe('Clinical records')
  })

  it('the surgical consent asks the procedure, risks explained, anaesthesia type, witness and a signature', () => {
    const qs = form('surgical_anaesthesia_consent').questions
    const byId = (id: string) => qs.find((q) => q.id === id)
    expect(byId('procedure')?.type).toBe('text')
    expect(byId('procedure')?.required).toBe(true)
    expect(byId('risks_explained')?.type).toBe('checkbox')
    expect(byId('risks_explained')?.required).toBe(true)
    expect(byId('anaesthesia_type')?.type).toBe('select')
    expect(byId('anaesthesia_type')?.options?.length).toBeGreaterThan(2)
    expect(byId('witness_name')?.type).toBe('text')
    expect(byId('witness_name')?.required).toBe(true)
    expect(qs.some((q) => q.type === 'signature' && q.required)).toBe(true)
  })

  it('the MLC intimation asks the police station and intimation time and is sensitive throughout', () => {
    const qs = form('mlc_intimation').questions
    expect(qs.find((q) => q.id === 'police_station')?.required).toBe(true)
    expect(qs.find((q) => q.id === 'intimation_time')?.required).toBe(true)
    expect(qs.every((q) => q.hipaaSensitive)).toBe(true)
  })

  it('uses no US terms or emojis', () => {
    const text = JSON.stringify(HOSPITAL_FORM_PACK)
    for (const banned of ['Notice of Privacy Practices', 'HIPAA', 'Social Security', 'Medicare', 'Medicaid', 'ZIP', 'SSN']) expect(text).not.toContain(banned)
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false)
  })
})

describe('seedHospitalForms', () => {
  it('creates the six templates once, attaches draft consents, and skips them on a second run', async () => {
    await inScratchTransaction(async (tx) => {
      const first = await seedHospitalForms(tx)
      expect(first.created).toEqual(HOSPITAL_FORM_PACK.map((f) => f.name))
      expect(first.skipped).toEqual([])

      const second = await seedHospitalForms(tx)
      expect(second.created).toEqual([])
      expect(second.skipped).toEqual(HOSPITAL_FORM_PACK.map((f) => f.name))

      for (const f of HOSPITAL_FORM_PACK) {
        const rows = await tx.select().from(formTemplates).where(eq(formTemplates.name, f.name))
        expect(rows, f.key).toHaveLength(1)
        expect(rows[0].category).toBe(f.category)
        expect(rows[0].languages).toEqual(['en', 'hi', 'kn'])
        expect(rows[0].questions).toEqual(f.questions)

        const links = await tx.select({ name: consentDocuments.name, status: consentDocuments.legalReviewStatus, translations: consentDocuments.translations, sortOrder: formTemplateConsents.sortOrder })
          .from(formTemplateConsents)
          .innerJoin(consentDocuments, eq(consentDocuments.id, formTemplateConsents.consentDocumentId))
          .where(eq(formTemplateConsents.formTemplateId, rows[0].id))
          .orderBy(formTemplateConsents.sortOrder)
        expect(links.map((l) => l.name), f.key).toEqual(f.consents.map((c) => c.name))
        for (const l of links) {
          expect(l.status).toBe('draft')
          expect(l.translations.hi?.bodyText?.startsWith(DRAFT)).toBe(true)
          expect(l.translations.kn?.bodyText?.startsWith(DRAFT)).toBe(true)
        }
      }

      for (const c of HOSPITAL_FORM_PACK.flatMap((f) => f.consents)) {
        expect(await tx.select().from(consentDocuments).where(eq(consentDocuments.name, c.name)), c.name).toHaveLength(1)
      }
    })
  })

  it('reuses a consent document that already exists by name instead of duplicating it', async () => {
    await inScratchTransaction(async (tx) => {
      const c = form('general_consent').consents[0]
      const [existing] = await tx.insert(consentDocuments).values({ name: c.name, bodyText: 'Hospital-edited wording', legalReviewStatus: 'reviewed' }).returning()
      await seedHospitalForms(tx)
      const docs = await tx.select().from(consentDocuments).where(eq(consentDocuments.name, c.name))
      expect(docs.map((d) => d.id)).toEqual([existing.id])
      expect(docs[0].bodyText).toBe('Hospital-edited wording')
      const [tpl] = await tx.select().from(formTemplates).where(eq(formTemplates.name, form('general_consent').name))
      const links = await tx.select().from(formTemplateConsents).where(eq(formTemplateConsents.formTemplateId, tpl.id))
      expect(links.map((l) => l.consentDocumentId)).toEqual([existing.id])
    })
  })
})
