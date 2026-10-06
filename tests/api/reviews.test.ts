import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { getDb } from '@/db/client'
import { formSubmissions, reviews, auditLog } from '@/db/schema'
import { eq, and, desc, or, like } from 'drizzle-orm'
import { GET as listReviews, POST as sendSurvey } from '@/app/api/reviews/route'
import { GET as getOneReview, PUT as recordResponse } from '@/app/api/reviews/[id]/route'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz' })) }))

// The "audit logging" tests below insert real auditLog rows via the real
// GET handlers against the shared dev DB -- clean them up, or they
// accumulate in the compliance log forever.
afterAll(async () => {
  await getDb().delete(auditLog).where(or(eq(auditLog.action, 'viewed experience surveys list'), like(auditLog.action, 'viewed experience survey %')))
})

describe('GET /api/reviews', () => {
  it('returns the seeded survey records', async () => {
    const req = new Request('http://localhost/api/reviews')
    const res = await listReviews(req as never)
    const body = await res.json()
    expect(body.length).toBeGreaterThanOrEqual(3)
  })
})

describe('GET /api/reviews audit logging', () => {
  it('logs an audit entry when the survey list is viewed', async () => {
    const req = new Request('http://localhost/api/reviews')
    await listReviews(req as never)
    // Scoped to this test's own action string, not "the globally latest row"
    // -- the shared dev DB has concurrent writers (other branches/worktrees),
    // so an unscoped "latest row" read is racy.
    const [latest] = await getDb().select().from(auditLog).where(eq(auditLog.action, 'viewed experience surveys list')).orderBy(desc(auditLog.id)).limit(1)
    expect(latest?.action).toBe('viewed experience surveys list')
  })

  it('logs an audit entry when a single survey is viewed', async () => {
    const [existing] = await getDb().select().from(reviews).limit(1)
    const req = new Request(`http://localhost/api/reviews/${existing.id}`)
    await getOneReview(req as never, { params: Promise.resolve({ id: String(existing.id) }) })
    const action = `viewed experience survey ${existing.id}`
    const [latest] = await getDb().select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.id)).limit(1)
    expect(latest?.action).toBe(action)
    expect(latest?.patientId).toBe(existing.patientId)
  })
})

describe('POST /api/reviews', () => {
  it('rejects sending a survey for a submission that is not completed', async () => {
    const [pending] = await getDb().select().from(formSubmissions).where(eq(formSubmissions.status, 'sent'))
    const req = new Request('http://localhost/api/reviews', { method: 'POST', body: JSON.stringify({ formSubmissionId: pending.id }) })
    const res = await sendSurvey(req as never)
    expect(res.status).toBe(400)
  })

  it('rejects sending a second survey for the same submission', async () => {
    const [alreadySurveyed] = await getDb().select().from(formSubmissions).where(and(eq(formSubmissions.patientId, 'RD-0001'), eq(formSubmissions.status, 'completed')))
    const req = new Request('http://localhost/api/reviews', { method: 'POST', body: JSON.stringify({ formSubmissionId: alreadySurveyed.id }) })
    const res = await sendSurvey(req as never)
    expect(res.status).toBe(409)
  })
})

describe('PUT /api/reviews/[id]', () => {
  // RD-0002's seeded survey is the one 'sent'-but-not-completed review; this
  // suite mutates it, then restores the original row so re-running the
  // suite (without a full reseed in between) stays idempotent, matching the
  // snapshot-restore pattern in tests/api/trials.test.ts.
  let reviewId: number
  let originalRow: typeof reviews.$inferSelect

  beforeAll(async () => {
    const [row] = await getDb().select().from(reviews).where(eq(reviews.status, 'sent'))
    reviewId = row.id
    originalRow = row
  })

  afterAll(async () => {
    await getDb().update(reviews).set(originalRow).where(eq(reviews.id, reviewId))
  })

  it('rejects an out-of-range rating', async () => {
    const req = new Request(`http://localhost/api/reviews/${reviewId}`, { method: 'PUT', body: JSON.stringify({ ratingOverall: 6, ratingFormsClarity: 5, ratingCommunication: 5 }) })
    const res = await recordResponse(req as never, { params: Promise.resolve({ id: String(reviewId) }) })
    expect(res.status).toBe(400)
  })

  it('records a valid response', async () => {
    const req = new Request(`http://localhost/api/reviews/${reviewId}`, { method: 'PUT', body: JSON.stringify({ ratingOverall: 4, ratingFormsClarity: 4, ratingCommunication: 5, comments: 'Great experience.' }) })
    const res = await recordResponse(req as never, { params: Promise.resolve({ id: String(reviewId) }) })
    expect(res.status).toBe(200)
  })

  it('rejects recording a response twice', async () => {
    const req = new Request(`http://localhost/api/reviews/${reviewId}`, { method: 'PUT', body: JSON.stringify({ ratingOverall: 5, ratingFormsClarity: 5, ratingCommunication: 5 }) })
    const res = await recordResponse(req as never, { params: Promise.resolve({ id: String(reviewId) }) })
    expect(res.status).toBe(409)
  })
})
