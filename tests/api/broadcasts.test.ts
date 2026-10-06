import { describe, it, expect, vi, afterAll } from 'vitest'
import { GET as listBroadcasts, POST as createBroadcast } from '@/app/api/broadcasts/route'
import { GET as getOneBroadcast } from '@/app/api/broadcasts/[id]/route'
import { GET as recipientPreview } from '@/app/api/broadcasts/recipients/route'
import { getDb } from '@/db/client'
import { broadcasts, auditLog } from '@/db/schema'
import { inArray, desc, eq, or, like } from 'drizzle-orm'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'Jamie Ruiz' })) }))

// This suite exercises the real create-broadcast DB path against the shared
// dev database (not mocked), so every broadcast it creates is tracked here
// and deleted afterward -- otherwise these rows accumulate permanently,
// since seed()'s guard against destructive reseeds means a non-empty
// `broadcasts` table is never cleared between runs.
const createdBroadcastIds: number[] = []
afterAll(async () => {
  if (createdBroadcastIds.length > 0) await getDb().delete(broadcasts).where(inArray(broadcasts.id, createdBroadcastIds))
})

// The "audit logging" tests below insert real auditLog rows via the real
// GET handlers (same shared-DB reasoning as createdBroadcastIds above) --
// clean them up too, or they accumulate in the compliance log forever.
afterAll(async () => {
  await getDb().delete(auditLog).where(or(eq(auditLog.action, 'viewed broadcasts list'), like(auditLog.action, 'viewed broadcast %')))
})

describe('GET /api/broadcasts', () => {
  it('returns the seeded broadcast history', async () => {
    const res = await listBroadcasts()
    const body = await res.json()
    expect(body.length).toBeGreaterThanOrEqual(4)
  })
})

describe('GET /api/broadcasts audit logging', () => {
  it('logs an audit entry when the broadcast list is viewed', async () => {
    await listBroadcasts()
    // Scoped to this test's own action string, not "the globally latest row"
    // -- the shared dev DB has concurrent writers (other branches/worktrees),
    // so an unscoped "latest row" read is racy.
    const [latest] = await getDb().select().from(auditLog).where(eq(auditLog.action, 'viewed broadcasts list')).orderBy(desc(auditLog.id)).limit(1)
    expect(latest?.action).toBe('viewed broadcasts list')
  })

  it('logs an audit entry when a single broadcast is viewed', async () => {
    const [existing] = await getDb().select().from(broadcasts).limit(1)
    const req = new Request(`http://localhost/api/broadcasts/${existing.id}`)
    await getOneBroadcast(req as never, { params: Promise.resolve({ id: String(existing.id) }) })
    const action = `viewed broadcast ${existing.id}`
    const [latest] = await getDb().select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.id)).limit(1)
    expect(latest?.action).toBe(action)
  })
})

describe('GET /api/broadcasts/recipients', () => {
  it('previews candidates for a filter without creating a broadcast', async () => {
    const req = new Request('http://localhost/api/broadcasts/recipients?trialId=nct06911112')
    const res = await recipientPreview(req as never)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })
})

describe('POST /api/broadcasts', () => {
  it('rejects an SMS message over 140 characters', async () => {
    const req = new Request('http://localhost/api/broadcasts', { method: 'POST', body: JSON.stringify({ message: 'x'.repeat(141), channel: 'sms' }) })
    const res = await createBroadcast(req as never)
    expect(res.status).toBe(400)
  })

  it('rejects an email broadcast with no subject', async () => {
    const req = new Request('http://localhost/api/broadcasts', { method: 'POST', body: JSON.stringify({ message: 'Hello', channel: 'email' }) })
    const res = await createBroadcast(req as never)
    expect(res.status).toBe(400)
  })

  it('rejects a filter that matches zero patients', async () => {
    const req = new Request('http://localhost/api/broadcasts', { method: 'POST', body: JSON.stringify({ message: 'Hello', channel: 'sms', filterTrialId: 'does-not-exist' }) })
    const res = await createBroadcast(req as never)
    expect(res.status).toBe(400)
  })

  it('creates a broadcast and snapshots the matching recipients', async () => {
    const req = new Request('http://localhost/api/broadcasts', { method: 'POST', body: JSON.stringify({ message: 'Test broadcast from the automated suite', channel: 'sms', filterTrialId: 'nct06911112' }) })
    const res = await createBroadcast(req as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    if (body.id) createdBroadcastIds.push(body.id)
    expect(body.recipientCount).toBeGreaterThan(0)
    expect(body.recipients.length).toBe(body.recipientCount)
  })
})
