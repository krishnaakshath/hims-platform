import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { POST as acknowledge } from '@/app/api/front-desk/assignments/[id]/acknowledge-decline/route'
import { getDb } from '@/db/client'
import { doctorAssignments, appointments, messages, auditLog } from '@/db/schema'
import { createDoctorAssignment, scheduleAssignment, declineAssignment, countUnacknowledgedDeclines } from '@/lib/queries/doctor-assignments'
import { listActiveProviders } from '@/lib/queries/providers'

let sessionRole: string | null = 'frontdesk'
const SESSION_NAME = 'Taylor Nguyen'

vi.mock('@/lib/auth', async () => {
  const { NextResponse: NR } = await import('next/server')
  return {
    requireSession: vi.fn(async () =>
      sessionRole === null ? NR.json({ error: 'Unauthorized' }, { status: 401 }) : { role: sessionRole, name: SESSION_NAME, userId: null },
    ),
  }
})

const ACTION = 'acknowledged declined assignment'
const assignmentIds: number[] = []
const appointmentIds: number[] = []
const auditIdsBefore = new Set<number>()

async function newAssignment() {
  const p = (await listActiveProviders())[0]
  const a = await createDoctorAssignment({ patientId: 'RD-0001', providerId: p.id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
  assignmentIds.push(a.id)
  return a
}
async function getRow(id: number) {
  const [row] = await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.id, id))
  return row
}
const post = (id: number | string) => acknowledge(new Request('http://localhost', { method: 'POST' }) as never, { params: Promise.resolve({ id: String(id) }) })
async function messageCount() {
  return (await getDb().select({ id: messages.id }).from(messages).where(eq(messages.patientId, 'RD-0001'))).length
}
async function ackAuditIds() {
  const rows = await getDb().select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.patientId, 'RD-0001'), eq(auditLog.action, ACTION)))
  return rows.map((r) => r.id)
}

// Snapshot before EVERY test, so cleanup removes only the audit rows created
// during that test -- never a pre-existing row.
beforeEach(async () => {
  auditIdsBefore.clear()
  for (const id of await ackAuditIds()) auditIdsBefore.add(id)
})

afterEach(async () => {
  sessionRole = 'frontdesk'
  const created = (await ackAuditIds()).filter((id) => !auditIdsBefore.has(id))
  if (created.length > 0) await getDb().delete(auditLog).where(inArray(auditLog.id, created))
  auditIdsBefore.clear()
  while (assignmentIds.length > 0) await getDb().delete(doctorAssignments).where(eq(doctorAssignments.id, assignmentIds.pop()!))
  if (appointmentIds.length > 0) await getDb().delete(appointments).where(inArray(appointments.id, appointmentIds.splice(0)))
})

describe('POST /api/front-desk/assignments/[id]/acknowledge-decline', () => {
  it('401 with no session', async () => {
    sessionRole = null
    const a = await newAssignment()
    await declineAssignment(a.id, 'x')
    expect((await post(a.id)).status).toBe(401)
    expect((await getRow(a.id)).declineAcknowledgedAt).toBeNull()
  })

  it.each(['pi', 'billing', 'pharmacy'])('403 for %s, row stays unacknowledged', async (role) => {
    sessionRole = role
    const a = await newAssignment()
    await declineAssignment(a.id, 'x')
    expect((await post(a.id)).status).toBe(403)
    expect((await getRow(a.id)).declineAcknowledgedAt).toBeNull()
  })

  it('400 for a non-integer id', async () => {
    expect((await post('abc')).status).toBe(400)
  })

  it('404 for unknown id', async () => {
    expect((await post(2147483000)).status).toBe(404)
  })

  it('409 for a pending assignment', async () => {
    const a = await newAssignment()
    const res = await post(a.id)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Only a declined assignment can be marked handled.' })
    expect((await getRow(a.id)).declineAcknowledgedAt).toBeNull()
  })

  it('409 for a scheduled assignment', async () => {
    const a = await newAssignment()
    const [appt] = await getDb().insert(appointments).values({
      patientId: 'RD-0001', providerId: a.providerId,
      startsAt: new Date('2026-12-01T09:00:00'), endsAt: new Date('2026-12-01T09:30:00'),
      visitReason: 'Follow-up', status: 'scheduled',
    }).returning()
    appointmentIds.push(appt.id)
    await scheduleAssignment(a.id, appt.id)
    const res = await post(a.id)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Only a declined assignment can be marked handled.' })
    const row = await getRow(a.id)
    expect(row.status).toBe('scheduled')
    expect(row.declineAcknowledgedAt).toBeNull()
  })

  it.each(['frontdesk', 'admin', 'crc'])('200 for %s on an unacknowledged decline: sets columns, no message, audits', async (role) => {
    sessionRole = role
    const a = await newAssignment()
    await declineAssignment(a.id, 'Fully booked')
    const msgsBefore = await messageCount()
    const unackBefore = await countUnacknowledgedDeclines()

    const res = await post(a.id)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(a.id)

    const row = await getRow(a.id)
    expect(row.declineAcknowledgedAt).not.toBeNull()
    expect(row.declineAcknowledgedByName).toBe(SESSION_NAME)
    expect(row.status).toBe('declined')
    expect(row.declineReason).toBe('Fully booked')
    expect(await messageCount()).toBe(msgsBefore)
    expect(await countUnacknowledgedDeclines()).toBe(unackBefore - 1)
    const newAudit = (await ackAuditIds()).filter((id) => !auditIdsBefore.has(id))
    expect(newAudit).toHaveLength(1)
  })

  it('409 on the second acknowledge, name and timestamp unchanged', async () => {
    const a = await newAssignment()
    await declineAssignment(a.id, 'x')
    expect((await post(a.id)).status).toBe(200)
    const first = await getRow(a.id)
    sessionRole = 'admin'
    const res = await post(a.id)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'This decline has already been marked handled.' })
    const second = await getRow(a.id)
    expect(second.declineAcknowledgedAt).toEqual(first.declineAcknowledgedAt)
    expect(second.declineAcknowledgedByName).toBe(SESSION_NAME)
  })
})
