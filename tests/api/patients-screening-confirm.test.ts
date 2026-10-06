import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { POST } from '@/app/api/patients/[anonId]/screening/confirm/route'
import { getDb } from '@/db/client'
import { patientTrialScreenings, messages } from '@/db/schema'

const PATIENT = 'RD-0003'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' = 'admin'
let sessionName = 'Dr. Rajiv Kunam'
let sessionOverride: unknown = undefined // when set, requireSession() returns this instead of a normal session

vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => {
    if (sessionOverride !== undefined) return sessionOverride
    return { role: sessionRole, name: sessionName }
  }),
}))

// Every test in this file mutates the real seeded RD-0003 screening row and
// may create real `messages` rows -- restore the screening to its captured
// pre-test state and delete every message this file created, same
// shared-dev-DB discipline as tests/lib/queries/eligibility.test.ts.
let original: typeof patientTrialScreenings.$inferSelect
const createdMessageIds: number[] = []

async function captureOriginal() {
  const [row] = await getDb().select().from(patientTrialScreenings).where(eq(patientTrialScreenings.patientId, PATIENT))
  original = row
}

async function setScreening(fields: Partial<{
  overallStatus: 'green' | 'yellow' | 'red'
  selectionConfirmedAt: Date | null
  selectionConfirmedByName: string | null
  selectionNotifiedAt: Date | null
}>) {
  await getDb().update(patientTrialScreenings).set(fields).where(eq(patientTrialScreenings.id, original.id))
}

async function getScreening() {
  const [row] = await getDb().select().from(patientTrialScreenings).where(eq(patientTrialScreenings.id, original.id))
  return row
}

afterEach(async () => {
  sessionRole = 'admin'
  sessionName = 'Dr. Rajiv Kunam'
  sessionOverride = undefined

  if (original) {
    await getDb()
      .update(patientTrialScreenings)
      .set({
        overallStatus: original.overallStatus,
        selectionConfirmedAt: original.selectionConfirmedAt,
        selectionConfirmedByName: original.selectionConfirmedByName,
        selectionNotifiedAt: original.selectionNotifiedAt,
      })
      .where(eq(patientTrialScreenings.id, original.id))
  }

  if (createdMessageIds.length > 0) {
    await getDb().delete(messages).where(inArray(messages.id, createdMessageIds))
    createdMessageIds.length = 0
  }
})

function req() {
  return new Request('http://localhost/api/patients/RD-0003/screening/confirm', { method: 'POST' })
}

function params(anonId = PATIENT) {
  return { params: Promise.resolve({ anonId }) }
}

describe('POST /api/patients/[anonId]/screening/confirm', () => {
  it.each(['admin', 'pi', 'crc'] as const)('%s gets 200 confirming a green, unconfirmed screening', async (role) => {
    await captureOriginal()
    await setScreening({ overallStatus: 'green', selectionConfirmedAt: null, selectionConfirmedByName: null, selectionNotifiedAt: null })
    sessionRole = role

    const res = await POST(req() as never, params())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)

    const updated = await getScreening()
    if (updated.selectionConfirmedAt) {
      // find the message we created so afterEach cleans it up
      const [msg] = await getDb().select().from(messages).where(eq(messages.patientId, PATIENT))
      if (msg) createdMessageIds.push(msg.id)
    }
  })

  it('a frontdesk session gets 403 and writes nothing', async () => {
    await captureOriginal()
    await setScreening({ overallStatus: 'green', selectionConfirmedAt: null, selectionConfirmedByName: null, selectionNotifiedAt: null })
    sessionRole = 'frontdesk'

    const before = await getDb().select().from(messages).where(eq(messages.patientId, PATIENT))

    const res = await POST(req() as never, params())
    expect(res.status).toBe(403)

    const updated = await getScreening()
    expect(updated.selectionConfirmedAt).toBeNull()
    expect(updated.selectionConfirmedByName).toBeNull()
    expect(updated.selectionNotifiedAt).toBeNull()

    const after = await getDb().select().from(messages).where(eq(messages.patientId, PATIENT))
    expect(after.length).toBe(before.length)
  })

  it('no session returns 401', async () => {
    await captureOriginal()
    sessionOverride = NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const res = await POST(req() as never, params())
    expect(res.status).toBe(401)
  })

  it('a patient with no screening row at all returns 404', async () => {
    const res = await POST(req() as never, params('RD-9999-nonexistent'))
    expect(res.status).toBe(404)
  })

  it('a yellow screening returns 409 and writes nothing', async () => {
    await captureOriginal()
    await setScreening({ overallStatus: 'yellow', selectionConfirmedAt: null, selectionConfirmedByName: null, selectionNotifiedAt: null })

    const before = await getDb().select().from(messages).where(eq(messages.patientId, PATIENT))

    const res = await POST(req() as never, params())
    expect(res.status).toBe(409)

    const updated = await getScreening()
    expect(updated.selectionConfirmedAt).toBeNull()

    const after = await getDb().select().from(messages).where(eq(messages.patientId, PATIENT))
    expect(after.length).toBe(before.length)
  })

  it('an already-confirmed screening returns 409 on the second call and creates no second message', async () => {
    await captureOriginal()
    await setScreening({ overallStatus: 'green', selectionConfirmedAt: null, selectionConfirmedByName: null, selectionNotifiedAt: null })

    const first = await POST(req() as never, params())
    expect(first.status).toBe(200)
    const afterFirst = await getDb().select().from(messages).where(eq(messages.patientId, PATIENT))
    const firstMsg = afterFirst.find((m) => m.senderRole === 'system')
    if (firstMsg) createdMessageIds.push(firstMsg.id)

    const before = await getDb().select().from(messages).where(eq(messages.patientId, PATIENT))
    const second = await POST(req() as never, params())
    expect(second.status).toBe(409)

    const after = await getDb().select().from(messages).where(eq(messages.patientId, PATIENT))
    expect(after.length).toBe(before.length)
  })

  it('success path: writes all three columns with the confirming session\'s name, and creates exactly one system message with the real trial name/site', async () => {
    await captureOriginal()
    await setScreening({ overallStatus: 'green', selectionConfirmedAt: null, selectionConfirmedByName: null, selectionNotifiedAt: null })
    sessionRole = 'pi'
    sessionName = 'Dr. Elena Bosch'

    const before = await getDb().select().from(messages).where(eq(messages.patientId, PATIENT))

    const res = await POST(req() as never, params())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.confirmedAt).toBeDefined()
    expect(body.notifiedAt).toBeDefined()

    const updated = await getScreening()
    expect(updated.selectionConfirmedAt).toBeInstanceOf(Date)
    expect(updated.selectionConfirmedByName).toBe('Dr. Elena Bosch')
    expect(updated.selectionNotifiedAt).toBeInstanceOf(Date)

    const after = await getDb().select().from(messages).where(eq(messages.patientId, PATIENT))
    const newMessages = after.filter((m) => !before.some((b) => b.id === m.id))
    expect(newMessages.length).toBe(1)
    expect(newMessages[0].senderRole).toBe('system')
    createdMessageIds.push(newMessages[0].id)

    const db = getDb()
    const { trials } = await import('@/db/schema')
    const [trial] = await db.select().from(trials).where(eq(trials.id, updated.trialId))
    expect(newMessages[0].body).toContain(trial.name)
    expect(newMessages[0].body).toContain(trial.site)
  })
})
