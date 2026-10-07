import type { FollowUpView } from '@/lib/follow-ups/view'
import type { EncounterListRow } from '@/lib/queries/encounters'

export const FU: FollowUpView = {
  id: 5, patientId: 'RD-0001', source: 'manual', status: 'planned', bucket: 'due',
  dueDate: '2026-10-21', windowStart: '2026-10-18', windowEnd: '2026-10-28', interval: null,
  reason: 'BP review', planNotes: 'Check renal panel first', prescribedBy: { providerId: 7, name: 'Dr. K' },
  department: { id: 2, name: 'Cardiology' }, appointment: null, createdByName: 'Dr. K', createdAt: new Date('2026-10-07T05:00:00Z'),
  scheduledByName: null, scheduledAt: null, cancelReason: null, contactAttempts: [], lastContact: null,
}

export const BOOKED: FollowUpView = {
  ...FU, status: 'scheduled', bucket: 'scheduled',
  appointment: { id: 31, startsAt: new Date('2026-10-21T19:00:00Z'), endsAt: new Date('2026-10-21T19:15:00Z'), status: 'scheduled', providerId: 7, providerName: 'Dr. K' },
}

export const ENC: EncounterListRow = {
  id: 90, encounterType: 'opd', visitType: 'new', status: 'checked_in', encounterDate: '2026-10-07', opdToken: 4,
  providerId: 7, providerName: 'Dr. K', departmentName: 'Cardiology', appointmentId: null, admissionId: null, checkedInAt: new Date('2026-10-07T05:00:00Z'),
}

export const PROPS = {
  patientId: 'RD-0001',
  followUps: [FU], encounters: [] as EncounterListRow[],
  providers: [{ id: 7, name: 'Dr. K' }, { id: 8, name: 'Dr. L' }],
  departments: [{ id: 2, name: 'Cardiology' }],
  todayIso: '2026-10-20',
  can: { plan: false, book: false, checkIn: false, startOrComplete: false, cancelVisit: false },
  isPi: false,
  selfProviderId: null as number | null,
}
