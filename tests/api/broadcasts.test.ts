import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { GET as listBroadcasts, POST as createBroadcast } from '@/app/api/broadcasts/route'
import { GET as getOneBroadcast } from '@/app/api/broadcasts/[id]/route'
import { GET as recipientPreview } from '@/app/api/broadcasts/recipients/route'
import { getDb } from '@/db/client'
import { broadcasts, auditLog, notificationLog, patients } from '@/db/schema'
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
  it('previews counts and sendable recipients for a filter without creating a broadcast', async () => {
    const req = new Request('http://localhost/api/broadcasts/recipients?trialId=nct06911112')
    const res = await recipientPreview(req as never)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.counts).toEqual(expect.objectContaining({ match: expect.any(Number), optedOut: expect.any(Number), noPhone: expect.any(Number), sendable: expect.any(Number) }))
    expect(Array.isArray(body.recipients)).toBe(true)
    // Preview carries UHID and name only, never contact details.
    for (const r of body.recipients) expect(Object.keys(r).sort()).toEqual(['id', 'name', 'uhid'])
  })

  // WS7 T10
  it('refuses trial filters (400) while trials are off', async () => {
    const prev = process.env.ENABLE_TRIALS
    process.env.ENABLE_TRIALS = 'false'
    try {
      const res = await recipientPreview(new Request('http://localhost/api/broadcasts/recipients?trialId=nct06911112') as never)
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('trial_filters_disabled')
    } finally {
      if (prev === undefined) delete process.env.ENABLE_TRIALS
      else process.env.ENABLE_TRIALS = prev
    }
  })
})

// WS7 T10: real sends through sendNotification. An isolated cohort (its own PIN code) keeps the
// counts exact; the test env has no SMS/WhatsApp provider, so a send is logged as log_only.
const P = `WS7BA-${process.pid}`
const PIN = '560976'
const cohort = { send: `${P}-S`, optedOut: `${P}-O`, noPhone: `${P}-N` }
const cohortIds = Object.values(cohort)
const filters = { pinCodePrefix: PIN }
const post = (body: unknown) => createBroadcast(new Request('http://localhost/api/broadcasts', { method: 'POST', body: JSON.stringify(body) }) as never)

beforeAll(async () => {
  await getDb().insert(patients).values([
    { id: cohort.send, name: 'Broadcast Send', dob: '1950-01-01', pinCode: PIN, phone: '9876501234' },
    { id: cohort.optedOut, name: 'Broadcast Opted Out', dob: '1950-01-01', pinCode: PIN, phone: '9876501235', notificationOptOut: true },
    { id: cohort.noPhone, name: 'Broadcast No Phone', dob: '1950-01-01', pinCode: PIN, phone: null },
  ])
})
afterAll(async () => {
  await getDb().delete(notificationLog).where(inArray(notificationLog.patientId, cohortIds))
  await getDb().delete(auditLog).where(eq(auditLog.action, 'sent broadcast'))
  await getDb().delete(patients).where(inArray(patients.id, cohortIds))
})

describe('POST /api/broadcasts', () => {
  it('rejects a message over 140 characters', async () => {
    const res = await post({ message: 'x'.repeat(141), filters, confirmCount: 1 })
    expect(res.status).toBe(400)
  })

  it('rejects the old simulated-channel body (strict)', async () => {
    const res = await post({ message: 'Hello', channel: 'sms', filters, confirmCount: 1 })
    expect(res.status).toBe(400)
  })

  it('refuses trial filters (400) while trials are off', async () => {
    const prev = process.env.ENABLE_TRIALS
    process.env.ENABLE_TRIALS = 'false'
    try {
      const res = await post({ message: 'Hello', filters: { trialId: 'nct06911112' }, confirmCount: 1 })
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('trial_filters_disabled')
    } finally {
      if (prev === undefined) delete process.env.ENABLE_TRIALS
      else process.env.ENABLE_TRIALS = prev
    }
  })

  it('answers 422 when nobody can receive the broadcast', async () => {
    const res = await post({ message: 'Hello', filters: { pinCodePrefix: '560975' }, confirmCount: 0 })
    expect(res.status).toBe(422)
  })

  it('refuses a wrong confirmCount with 409 and the fresh count, sending nothing', async () => {
    const res = await post({ message: 'Hello', filters, confirmCount: 3 })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'count_changed', count: 1 })
    expect(await getDb().select().from(notificationLog).where(inArray(notificationLog.patientId, cohortIds))).toEqual([])
  })

  it('sends broadcast_notice to each sendable recipient, logs it, and stores sent/skipped/failed', async () => {
    const res = await post({ message: 'Free health check camp this Sunday, 9 am to 1 pm.', filters, confirmCount: 1 })
    expect(res.status).toBe(201)
    const body = await res.json()
    createdBroadcastIds.push(body.id)
    // No provider in the test env: the notice is logged (log_only), which counts as not delivered.
    expect(body).toMatchObject({ recipientCount: 3, sentCount: 0, skippedCount: 2, failedCount: 1 })

    const log = await getDb().select().from(notificationLog).where(eq(notificationLog.dedupeKey, `broadcast:${body.id}`))
    expect(log.length).toBeGreaterThan(0)
    expect(new Set(log.map((l) => l.patientId))).toEqual(new Set([cohort.send]))
    expect(log.every((l) => l.templateKey === 'broadcast_notice')).toBe(true)

    const [row] = await getDb().select().from(broadcasts).where(eq(broadcasts.id, body.id))
    expect(row).toMatchObject({ templateKey: 'broadcast_notice', filters, recipientCount: 3, sentCount: 0, skippedCount: 2, failedCount: 1 })

    // Audit: ids and counts only -- never the message, a name or a phone.
    const [audit] = await getDb().select().from(auditLog).where(eq(auditLog.action, 'sent broadcast')).orderBy(desc(auditLog.id)).limit(1)
    expect(audit.details).toBe(`broadcast=${body.id} matched=3 sent=0 skipped=2 failed=1`)
  })
})
