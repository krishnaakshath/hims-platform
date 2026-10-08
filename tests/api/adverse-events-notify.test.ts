// Wave H P1-26: PATCH /api/trials/[trialId]/adverse-events records a sponsor/IRB
// notification only for an event of THAT trial (404 otherwise), and a second
// recording of the same notification is a 409, not a silent overwrite.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { eq, ne } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { adverseEvents, patients, trials } from '@/db/schema'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'crc', name: 'Test crc', userId: null })) }
})
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))

import { PATCH } from '@/app/api/trials/[trialId]/adverse-events/route'
import { createAdverseEvent } from '@/lib/queries/trial-compliance'

const PATIENT = `TEST_WH_AE_${Date.now()}`
let trialA = ''
let trialB = ''
let eventId = 0

beforeAll(async () => {
  const db = getDb()
  const rows = await db.select({ id: trials.id }).from(trials).limit(2)
  trialA = rows[0].id
  trialB = (await db.select({ id: trials.id }).from(trials).where(ne(trials.id, trialA)).limit(1))[0]?.id ?? 'probe-no-trial'
  await db.insert(patients).values({ id: PATIENT, name: 'AE Notify Probe', dob: '1990-01-01' })
  const created = await createAdverseEvent({
    trialId: trialA, patientId: PATIENT, description: 'probe', severity: 'mild', serious: false,
    causality: 'unlikely', onsetDate: '2026-09-01', reportedDate: '2026-09-02', reportedByName: 'Probe',
  })
  eventId = created.id
})

afterAll(async () => {
  const db = getDb()
  await db.delete(adverseEvents).where(eq(adverseEvents.patientId, PATIENT))
  await db.delete(patients).where(eq(patients.id, PATIENT))
})

const patch = (trialId: string, body: unknown) =>
  PATCH(new NextRequest('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ trialId }) })

describe('PATCH adverse-events (notify)', () => {
  it('404s an event that belongs to a different trial, and changes nothing', async () => {
    const res = await patch(trialB, { id: eventId, which: 'sponsor' })
    expect(res.status).toBe(404)
    const [row] = await getDb().select({ s: adverseEvents.sponsorNotifiedAt }).from(adverseEvents).where(eq(adverseEvents.id, eventId))
    expect(row.s).toBeNull()
  })

  it('404s an unknown event id', async () => {
    expect((await patch(trialA, { id: 2147483000, which: 'irb' })).status).toBe(404)
  })

  it('records the notification once; a repeat is a 409', async () => {
    expect((await patch(trialA, { id: eventId, which: 'sponsor' })).status).toBe(200)
    const again = await patch(trialA, { id: eventId, which: 'sponsor' })
    expect(again.status).toBe(409)
    expect((await again.json()).error).toMatch(/already/i)
  })
})
