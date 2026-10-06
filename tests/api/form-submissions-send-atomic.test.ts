import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { formSubmissions, formTemplates } from '@/db/schema'

// Final whole-branch review of feature/forms-redesign, I4: the submission
// insert and copyTemplateConsentsToSubmission must commit or roll back
// together. A submission left behind without its consent rows would pass the
// completion gate with nothing to sign.

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz', userId: null })) }))

const copyCalls: { formSubmissionId: number; hadExecutor: boolean }[] = []
vi.mock('@/lib/queries/form-submission-consents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queries/form-submission-consents')>()
  return {
    ...actual,
    copyTemplateConsentsToSubmission: vi.fn(async (_templateId: number, formSubmissionId: number, executor?: unknown) => {
      copyCalls.push({ formSubmissionId, hadExecutor: executor != null })
      throw new Error('simulated consent copy failure')
    }),
  }
})

const { POST } = await import('@/app/api/form-submissions/route')

const templateIds: number[] = []
afterEach(async () => {
  const db = getDb()
  // Defensive: if the transaction did NOT roll back, remove the leaked row.
  for (const c of copyCalls) await db.delete(formSubmissions).where(eq(formSubmissions.id, c.formSubmissionId))
  copyCalls.length = 0
  while (templateIds.length) await db.delete(formTemplates).where(eq(formTemplates.id, templateIds.pop()!))
})

describe('POST /api/form-submissions -- atomic send', () => {
  it('leaves no form_submissions row when copying the consent snapshot fails', async () => {
    const [t] = await getDb().insert(formTemplates).values({ name: `Atomic Send Test ${Date.now()}`, category: 'Uncategorized', diagnosisTag: 'test', questions: [] }).returning()
    templateIds.push(t.id)

    const req = new Request('http://localhost/api/form-submissions', { method: 'POST', body: JSON.stringify({ templateId: t.id, patientId: 'RD-0001' }) })
    await expect(POST(req as never)).rejects.toThrow('simulated consent copy failure')

    expect(copyCalls).toHaveLength(1)
    expect(copyCalls[0].hadExecutor).toBe(true) // the route passed its tx through
    const leaked = await getDb().select().from(formSubmissions).where(eq(formSubmissions.id, copyCalls[0].formSubmissionId))
    expect(leaked).toHaveLength(0)
  })
})
