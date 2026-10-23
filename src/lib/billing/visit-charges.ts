// WS2 T9: pure rules for the automatic visit charges (spec ruling 6).
// - Registration: the patient's first ever non-cancelled encounter, one live line per patient.
// - OPD consultation: at check-in (re-checked at completion), unless a follow-up/review falls
//   within billing_settings.free_review_days of the last charged consultation of the department.
// - IPD and lab encounters get no automatic visit charge.
import { addDaysIso } from '@/lib/follow-ups/rules'

export type AutoChargeSource = 'registration' | 'consultation' | 'lab_order' | 'procedure'

export interface VisitChargePlanInput {
  encounterType: 'opd' | 'ipd' | 'lab'
  visitType: 'new' | 'follow_up' | 'review' | 'emergency'
  encounterDate: string
  departmentId: number | null
  /** A non-void registration line already exists for the patient. */
  hasLiveRegistrationLine: boolean
  /** The patient's other non-cancelled encounters (any type). */
  priorEncounterCount: number
  /** Service date of the patient's latest live consultation line in this department (another visit). */
  lastChargedConsultDate: string | null
  freeReviewDays: number
}

export interface VisitChargePlan {
  registration: boolean
  consultation: boolean
  consultationSkip: 'ipd' | 'lab' | 'free_review' | 'no_department' | null
}

export function planVisitCharges(i: VisitChargePlanInput): VisitChargePlan {
  if (i.encounterType === 'ipd') return { registration: false, consultation: false, consultationSkip: 'ipd' }
  if (i.encounterType === 'lab') return { registration: false, consultation: false, consultationSkip: 'lab' }
  const registration = !i.hasLiveRegistrationLine && i.priorEncounterCount === 0
  if (i.departmentId === null) return { registration, consultation: false, consultationSkip: 'no_department' }
  const isReview = i.visitType === 'follow_up' || i.visitType === 'review'
  if (isReview && i.freeReviewDays > 0 && i.lastChargedConsultDate !== null
    && i.encounterDate <= addDaysIso(i.lastChargedConsultDate, i.freeReviewDays)) {
    return { registration, consultation: false, consultationSkip: 'free_review' }
  }
  return { registration, consultation: true, consultationSkip: null }
}

/** Ruling 6 bill-to: lines in an admission bill the primary payer when one is set; everything else is self-pay. */
export function autoBillTo(ctx: { admissionId: number | null; primaryPayerId: number | null; isInpatient: boolean }): 'self' | 'payer' {
  return (ctx.admissionId !== null || ctx.isInpatient) && ctx.primaryPayerId !== null ? 'payer' : 'self'
}
