import { describe, it, expect, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as auth from '@/lib/auth'
import { GET } from '@/app/api/form-submissions/[id]/route'
import { getDb } from '@/db/client'
import { formTemplates, formSubmissions } from '@/db/schema'

// Per-test role override pattern from tests/api/patients.test.ts: import the
// real module via vi.importActual and override only requireSession, so each
// it() below can set its own role with mockResolvedValueOnce without
// stripping any other export of @/lib/auth.
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'crc' as const, name: 'Test CRC' })) }
})

const PATIENT_ID = 'RD-0001' // seeded real patient

const createdTemplateIds: number[] = []
const createdSubmissionIds: number[] = []
afterEach(async () => {
  while (createdSubmissionIds.length > 0) await getDb().delete(formSubmissions).where(eq(formSubmissions.id, createdSubmissionIds.pop()!))
  while (createdTemplateIds.length > 0) await getDb().delete(formTemplates).where(eq(formTemplates.id, createdTemplateIds.pop()!))
})

async function makeSubmission() {
  const db = getDb()
  const [template] = await db.insert(formTemplates).values({
    name: `Test Answer Visibility ${Date.now()}`, category: 'Screening Questionnaires', diagnosisTag: 'test', questions: [],
  }).returning()
  createdTemplateIds.push(template.id)
  const [submission] = await db.insert(formSubmissions).values({
    templateId: template.id, patientId: PATIENT_ID, status: 'completed', answers: { q1: 'yes' },
  }).returning()
  createdSubmissionIds.push(submission.id)
  return submission
}

describe('GET /api/form-submissions/[id] -- answer visibility for admin and pi', () => {
  it('returns the real submitted answer to an admin session', async () => {
    const submission = await makeSubmission()
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'admin', name: 'Test Admin', userId: null })
    const res = await GET(new Request(`http://localhost/api/form-submissions/${submission.id}`) as never, { params: Promise.resolve({ id: String(submission.id) }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.answers.q1).toBe('yes')
  })

  it('returns the real submitted answer to a pi session', async () => {
    const submission = await makeSubmission()
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name: 'Test PI', userId: null })
    const res = await GET(new Request(`http://localhost/api/form-submissions/${submission.id}`) as never, { params: Promise.resolve({ id: String(submission.id) }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.answers.q1).toBe('yes')
  })
})
