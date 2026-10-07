import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { GET, POST } from '@/app/api/form-submissions/route'
import { GET as getOne, PUT as putOne } from '@/app/api/form-submissions/[id]/route'
import * as auth from '@/lib/auth'
import { getDb } from '@/db/client'
import { formTemplates, formSubmissions } from '@/db/schema'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz' })) }))
// Audit rows are append-only compliance records; this file asserts nothing about them, so keep them out of the shared DB.
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))

// The seeded template IDs are serial and drift across reseeds of the shared
// dev database, so tests look up a real, currently-valid template ID rather
// than assuming any fixed value.
async function realTemplateId(): Promise<number> {
  const [row] = await getDb().select({ id: formTemplates.id }).from(formTemplates).limit(1)
  if (!row) throw new Error('No seeded form templates found -- run npm run db:seed')
  return row.id
}

describe('GET /api/form-submissions', () => {
  it('returns seeded submissions', async () => {
    const req = new Request('http://localhost/api/form-submissions')
    const res = await GET(req as never)
    const body = await res.json()
    expect(body.length).toBeGreaterThan(0)
  })
})

describe('POST /api/form-submissions', () => {
  // Every successful POST inserts a real row into the shared dev DB -- this
  // test file was previously missing this cleanup entirely, and running the
  // suite repeatedly during a session left 200+ junk "sent" submissions
  // piled onto RD-0001, flooding the Home dashboard's real Latest/Pending
  // Forms widgets with duplicate entries. Track and delete each one created.
  const createdIds: number[] = []
  afterEach(async () => {
    while (createdIds.length > 0) {
      const id = createdIds.pop()!
      await getDb().delete(formSubmissions).where(eq(formSubmissions.id, id))
    }
  })

  it('rejects a payload with an unknown field (mass-assignment guard)', async () => {
    const templateId = await realTemplateId()
    const req = new Request('http://localhost/api/form-submissions', { method: 'POST', body: JSON.stringify({ templateId, patientId: 'RD-0001', status: 'completed' }) })
    const res = await POST(req as never)
    expect(res.status).toBe(400) // 'status' is not in sendFormSchema — new submissions always start 'sent'
  })

  it('generates a unique access token and a 30-day expiry when a form is sent', async () => {
    const templateId = await realTemplateId()
    const req = new Request('http://localhost/api/form-submissions', { method: 'POST', body: JSON.stringify({ templateId, patientId: 'RD-0001' }) })
    const res = await POST(req as never)
    const body = await res.json()
    createdIds.push(body.id)
    expect(body.accessToken).toBeTruthy()
    expect(typeof body.accessToken).toBe('string')
    expect(body.accessToken.length).toBeGreaterThan(30)
    expect(new Date(body.tokenExpiresAt).getTime()).toBeGreaterThan(Date.now())
  })
})

describe('form-submissions role gate', () => {
  const gateCreatedIds: number[] = []
  afterEach(async () => {
    while (gateCreatedIds.length > 0) await getDb().delete(formSubmissions).where(eq(formSubmissions.id, gateCreatedIds.pop()!))
  })

  async function submissionCount(): Promise<number> {
    const [row] = await getDb().select({ n: sql<number>`count(*)` }).from(formSubmissions)
    return Number(row.n)
  }

  it.each(['frontdesk', 'pharmacy', 'billing', 'labs', 'coder'] as const)('403s %s on GET list, POST, GET by id and PUT without creating or changing a row', async (role) => {
    const [existing] = await getDb().select().from(formSubmissions).limit(1)
    const templateId = await realTemplateId()
    const beforeCount = await submissionCount()
    const ctx = { params: Promise.resolve({ id: String(existing.id) }) }
    const as = () => vi.mocked(auth.requireSession).mockResolvedValueOnce({ role, name: `Test ${role}`, userId: null })
    const results: Response[] = []
    as(); results.push(await GET(new Request('http://localhost/api/form-submissions') as never))
    as()
    const postRes = await POST(new Request('http://localhost/api/form-submissions', { method: 'POST', body: JSON.stringify({ templateId, patientId: 'RD-0001' }) }) as never)
    // A gate regression would create a row; record any id so cleanup deletes it by explicit id.
    const leaked = await postRes.clone().json().catch(() => null)
    if (typeof leaked?.id === 'number') gateCreatedIds.push(leaked.id)
    results.push(postRes)
    as(); results.push(await getOne(new Request(`http://localhost/api/form-submissions/${existing.id}`) as never, ctx))
    as(); results.push(await putOne(new Request(`http://localhost/api/form-submissions/${existing.id}`, { method: 'PUT', body: JSON.stringify({ status: 'partial', answers: { q1: 'x' } }) }) as never, ctx))
    for (const res of results) {
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(await submissionCount()).toBe(beforeCount)
    const [after] = await getDb().select().from(formSubmissions).where(eq(formSubmissions.id, existing.id))
    expect(after.answers).toEqual(existing.answers)
    expect(after.status).toBe(existing.status)
  })

  it('admits pi on GET by id (existing seeded submission)', async () => {
    const [existing] = await getDb().select().from(formSubmissions).limit(1)
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name: 'Test PI', userId: null })
    const res = await getOne(new Request(`http://localhost/api/form-submissions/${existing.id}`) as never, { params: Promise.resolve({ id: String(existing.id) }) })
    expect(res.status).toBe(200)
  })
})
