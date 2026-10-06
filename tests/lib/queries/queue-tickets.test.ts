import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { doctorAssignments } from '@/db/schema'
import { getNextQueueTicketNumberForToday } from '@/lib/queries/queue-tickets'
import { createDoctorAssignment } from '@/lib/queries/doctor-assignments'
import { listActiveProviders } from '@/lib/queries/providers'

const createdAssignmentIds: number[] = []
afterEach(async () => {
  while (createdAssignmentIds.length > 0) await getDb().delete(doctorAssignments).where(eq(doctorAssignments.id, createdAssignmentIds.pop()!))
})

describe('queue ticket generation', () => {
  it('assigns sequential ticket numbers to two patients checked in the same day', async () => {
    const providers = await listActiveProviders()
    const first = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Test Staff' })
    createdAssignmentIds.push(first.id)
    const second = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Test Staff' })
    createdAssignmentIds.push(second.id)

    expect(second.queueTicketNumber).toBe(first.queueTicketNumber + 1)
  })

  it('excludes an assignment created yesterday from today\'s count (day-boundary correctness — Review Focus #4)', async () => {
    const providers = await listActiveProviders()
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const [oldRow] = await getDb().insert(doctorAssignments).values({
      patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine',
      reason: 'Old', assignedByName: 'Test Staff', queueTicketNumber: 999, createdAt: yesterday,
    }).returning()
    createdAssignmentIds.push(oldRow.id)

    const created = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Today', roomId: null, assignedByName: 'Test Staff' })
    createdAssignmentIds.push(created.id)

    // If yesterday's row leaked into today's count, this would be >= 1000.
    expect(created.queueTicketNumber).toBeLessThan(999)
  })

  it('getNextQueueTicketNumberForToday reflects a row just created', async () => {
    const before = await getNextQueueTicketNumberForToday()
    const providers = await listActiveProviders()
    const created = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providers[0].id, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Test Staff' })
    createdAssignmentIds.push(created.id)
    const after = await getNextQueueTicketNumberForToday()
    expect(after).toBe(before + 1)
  })
})
