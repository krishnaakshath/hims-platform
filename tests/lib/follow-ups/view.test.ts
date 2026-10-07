import { describe, it, expect } from 'vitest'
import { toFollowUpView, toPortalFollowUp, type FollowUpJoinedRow } from '@/lib/follow-ups/view'

const ROW: FollowUpJoinedRow = {
  id: 11,
  patientId: 'P-1',
  source: 'encounter',
  status: 'planned',
  prescribedByProviderId: 5,
  departmentId: 3,
  baseDate: '2026-10-07',
  dueDate: '2026-10-21',
  windowStart: '2026-10-18',
  windowEnd: '2026-10-28',
  intervalValue: 2,
  intervalUnit: 'weeks',
  reason: 'BP review',
  planNotes: 'Titrate amlodipine',
  originatingEncounterId: 9,
  originatingAdmissionId: null,
  originatingLabOrderId: null,
  appointmentId: null,
  completedEncounterId: null,
  createdByName: 'Dr Rao',
  createdByUserId: 1,
  createdAt: new Date('2026-10-07T05:00:00Z'),
  updatedAt: new Date('2026-10-07T05:00:00Z'),
  planUpdatedAt: null,
  planUpdatedByName: null,
  scheduledAt: null,
  scheduledByName: null,
  scheduledByUserId: null,
  completedAt: null,
  cancelledAt: null,
  cancelledByName: null,
  cancelReason: null,
  prescriberName: 'Dr Rao',
  departmentName: 'Cardiology',
  appointment: null,
  contactAttempts: [
    { id: 1, channel: 'phone', outcome: 'no_answer', note: null, attemptedByName: 'Desk A', attemptedAt: new Date('2026-10-19T04:00:00Z') },
    { id: 2, channel: 'sms', outcome: 'message_left', note: 'left msg', attemptedByName: 'Desk B', attemptedAt: new Date('2026-10-20T04:00:00Z') },
  ],
}

const BOOKED: FollowUpJoinedRow = {
  ...ROW,
  status: 'scheduled',
  appointmentId: 77,
  appointment: { id: 77, startsAt: new Date('2026-10-22T04:30:00Z'), endsAt: new Date('2026-10-22T04:45:00Z'), status: 'scheduled', providerId: 6, providerName: 'Dr Iyer' },
}

describe('toFollowUpView', () => {
  it('toFollowUpView nulls planNotes for frontdesk and keeps it for pi/crc', () => {
    expect(toFollowUpView(ROW, '2026-10-20', 'frontdesk').planNotes).toBeNull()
    expect(toFollowUpView(ROW, '2026-10-20', 'pi').planNotes).toBe('Titrate amlodipine')
    expect(toFollowUpView(ROW, '2026-10-20', 'crc').planNotes).toBe('Titrate amlodipine')
    expect(toFollowUpView(ROW, '2026-10-20', 'admin').planNotes).toBe('Titrate amlodipine')
    expect(toFollowUpView(ROW, '2026-10-20', 'frontdesk').reason).toBe('BP review')
  })

  it('never carries plan notes for any non-clinical role, anywhere in the payload', () => {
    for (const role of ['frontdesk', 'billing', 'pharmacy', 'labs'] as const) {
      expect(JSON.stringify(toFollowUpView(ROW, '2026-10-20', role))).not.toContain('Titrate amlodipine')
    }
  })

  it('is an explicit projection: raw order columns do not ride along', () => {
    const v = toFollowUpView(ROW, '2026-10-20', 'admin') as unknown as Record<string, unknown>
    for (const k of ['baseDate', 'createdByUserId', 'scheduledByUserId', 'originatingLabOrderId', 'intervalValue', 'prescribedByProviderId']) {
      expect(k in v).toBe(false)
    }
  })

  it('derives status and bucket', () => {
    expect(toFollowUpView(ROW, '2026-10-29', 'admin')).toMatchObject({ status: 'planned', bucket: 'overdue' })
    expect(toFollowUpView(ROW, '2026-10-20', 'admin')).toMatchObject({ status: 'planned', bucket: 'due' })
    expect(toFollowUpView(ROW, '2026-11-12', 'admin')).toMatchObject({ status: 'missed', bucket: 'missed' })
    expect(toFollowUpView(BOOKED, '2026-10-20', 'admin')).toMatchObject({ status: 'scheduled', bucket: 'scheduled' })
    // A calendar cancel falls back to planned (Review Focus 5).
    const cancelledAppt = { ...BOOKED, appointment: { ...BOOKED.appointment!, status: 'cancelled' as const } }
    expect(toFollowUpView(cancelledAppt, '2026-10-20', 'admin')).toMatchObject({ status: 'planned', bucket: 'due' })
  })

  it('maps interval, prescriber, department and orders contact attempts newest first', () => {
    const v = toFollowUpView(ROW, '2026-10-20', 'frontdesk')
    expect(v.interval).toEqual({ value: 2, unit: 'weeks' })
    expect(v.prescribedBy).toEqual({ providerId: 5, name: 'Dr Rao' })
    expect(v.department).toEqual({ id: 3, name: 'Cardiology' })
    expect(v.contactAttempts.map((a) => a.id)).toEqual([2, 1])
    expect(v.lastContact?.id).toBe(2)
    expect(toFollowUpView({ ...ROW, intervalValue: null, intervalUnit: null, departmentId: null, departmentName: null, contactAttempts: [] }, '2026-10-20', 'admin'))
      .toMatchObject({ interval: null, department: null, contactAttempts: [], lastContact: null })
  })
})

describe('toPortalFollowUp', () => {
  it('portal projection has exactly the allowed keys', () => {
    expect(Object.keys(toPortalFollowUp(toFollowUpView(ROW, '2026-10-20', 'admin'))).sort())
      .toEqual(['appointmentStartsAt', 'doctorName', 'dueDate', 'status', 'windowEnd', 'windowStart'])
  })

  it('carries no reason or notes text', () => {
    const json = JSON.stringify(toPortalFollowUp(toFollowUpView(ROW, '2026-10-20', 'admin')))
    expect(json).not.toContain('BP review')
    expect(json).not.toContain('Titrate')
    expect(json).not.toContain('left msg')
  })

  it('doctorName is the booked provider, else the prescriber', () => {
    expect(toPortalFollowUp(toFollowUpView(ROW, '2026-10-20', 'admin'))).toEqual({
      dueDate: '2026-10-21', windowStart: '2026-10-18', windowEnd: '2026-10-28', status: 'planned', appointmentStartsAt: null, doctorName: 'Dr Rao',
    })
    expect(toPortalFollowUp(toFollowUpView(BOOKED, '2026-10-20', 'admin'))).toMatchObject({
      status: 'scheduled', appointmentStartsAt: new Date('2026-10-22T04:30:00Z'), doctorName: 'Dr Iyer',
    })
    const cancelledAppt = { ...BOOKED, appointment: { ...BOOKED.appointment!, status: 'cancelled' as const } }
    expect(toPortalFollowUp(toFollowUpView(cancelledAppt, '2026-10-20', 'admin'))).toMatchObject({ status: 'planned', appointmentStartsAt: null, doctorName: 'Dr Rao' })
  })
})
