import { z } from 'zod'
import { VISIT_REASON_MAX_LENGTH } from '@/lib/notification-templates'

/** Server-side rule for any client-supplied reason that becomes a
 *  patient-visible visit reason (doctor_assignments.reason at check-in,
 *  appointments.visit_reason). Trimmed first, so the stored value is the
 *  trimmed one and surrounding whitespace never counts toward the cap. */
export const visitReasonSchema = z.string().trim().min(1).max(VISIT_REASON_MAX_LENGTH)
