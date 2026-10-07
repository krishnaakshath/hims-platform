// Pure, client-safe projections of a follow-up order. Every view is built by
// naming its fields: no spread of the DB row, so a column added later never
// reaches the front desk or the portal by accident. Clinical plan notes and
// the cancel reason are released only to FOLLOW_UP_CLINICAL_NOTES_ROLES.
import type { Role } from '@/lib/auth'
import type { FollowUpOrderRow } from '@/db/schema'
import { FOLLOW_UP_CLINICAL_NOTES_ROLES } from '@/lib/role-policy'
import {
  deriveFollowUpStatus, recallBucket,
  type ApptStatus, type FollowUpInterval, type FollowUpStatus, type RecallBucket,
} from '@/lib/follow-ups/rules'
import type { CONTACT_CHANNELS, CONTACT_OUTCOMES } from '@/lib/follow-ups/validation'

export type ContactChannel = (typeof CONTACT_CHANNELS)[number]
export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number]

export interface ContactAttemptView {
  id: number
  channel: ContactChannel
  outcome: ContactOutcome
  note: string | null
  attemptedByName: string
  attemptedAt: Date
}

export interface FollowUpAppointmentView {
  id: number
  startsAt: Date
  endsAt: Date
  status: ApptStatus
  providerId: number
  providerName: string
}

export type FollowUpJoinedRow = FollowUpOrderRow & {
  prescriberName: string
  departmentName: string | null
  appointment: FollowUpAppointmentView | null
  contactAttempts: ContactAttemptView[]
}

export interface FollowUpView {
  id: number
  patientId: string
  source: FollowUpOrderRow['source']
  status: FollowUpStatus
  bucket: RecallBucket
  dueDate: string
  windowStart: string
  windowEnd: string
  interval: FollowUpInterval | null
  reason: string
  planNotes: string | null
  prescribedBy: { providerId: number; name: string }
  department: { id: number; name: string } | null
  appointment: FollowUpJoinedRow['appointment']
  createdByName: string
  createdAt: Date
  scheduledByName: string | null
  scheduledAt: Date | null
  cancelReason: string | null
  contactAttempts: ContactAttemptView[]
  lastContact: ContactAttemptView | null
}

function attemptView(a: ContactAttemptView): ContactAttemptView {
  return { id: a.id, channel: a.channel, outcome: a.outcome, note: a.note, attemptedByName: a.attemptedByName, attemptedAt: a.attemptedAt }
}

function appointmentView(a: FollowUpAppointmentView | null): FollowUpAppointmentView | null {
  return a ? { id: a.id, startsAt: a.startsAt, endsAt: a.endsAt, status: a.status, providerId: a.providerId, providerName: a.providerName } : null
}

export function toFollowUpView(row: FollowUpJoinedRow, todayIso: string, role: Role): FollowUpView {
  const status = deriveFollowUpStatus(
    { status: row.status, windowEnd: row.windowEnd, appointment: row.appointment ? { status: row.appointment.status, startsAt: row.appointment.startsAt } : null },
    todayIso,
  )
  const contactAttempts = [...row.contactAttempts]
    .sort((a, b) => b.attemptedAt.getTime() - a.attemptedAt.getTime() || b.id - a.id)
    .map(attemptView)
  const clinical = FOLLOW_UP_CLINICAL_NOTES_ROLES.includes(role)
  return {
    id: row.id,
    patientId: row.patientId,
    source: row.source,
    status,
    bucket: recallBucket(status, row.windowStart, row.windowEnd, todayIso),
    dueDate: row.dueDate,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    interval: row.intervalValue !== null && row.intervalUnit !== null ? { value: row.intervalValue, unit: row.intervalUnit } : null,
    reason: row.reason,
    planNotes: clinical ? row.planNotes : null,
    prescribedBy: { providerId: row.prescribedByProviderId, name: row.prescriberName },
    department: row.departmentId !== null && row.departmentName !== null ? { id: row.departmentId, name: row.departmentName } : null,
    appointment: appointmentView(row.appointment),
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    scheduledByName: row.scheduledByName,
    scheduledAt: row.scheduledAt,
    // Ruling 2: why a doctor cancelled is clinical, like the plan notes.
    cancelReason: clinical ? row.cancelReason : null,
    contactAttempts,
    lastContact: contactAttempts[0] ?? null,
  }
}

/** The portal payload: dates, status and who to see. No reason, notes or ids. */
export interface PortalFollowUp {
  dueDate: string
  windowStart: string
  windowEnd: string
  status: FollowUpStatus
  appointmentStartsAt: Date | null
  doctorName: string | null
}

export function toPortalFollowUp(v: FollowUpView): PortalFollowUp {
  const booked = v.status === 'scheduled' && v.appointment?.status === 'scheduled' ? v.appointment : null
  return {
    dueDate: v.dueDate,
    windowStart: v.windowStart,
    windowEnd: v.windowEnd,
    status: v.status,
    appointmentStartsAt: booked ? booked.startsAt : null,
    doctorName: booked ? booked.providerName : v.prescribedBy.name,
  }
}
