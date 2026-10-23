// WS3 T7: nursing vitals. Lane ruling R4: encounter_vitals is the one vitals table and
// src/lib/encounters/vitals.ts the one reading vocabulary (ranges, units, at-least-one-measure).
// This module adds only what the ward needs on top: a charting time and the ward warnings.
import { z } from 'zod'
import { appointmentInstantSchema } from '@/lib/appointment-time'
import { vitalsInputSchema, type VitalsColumns, type VitalsInput } from '@/lib/encounters/vitals'

/** A reading may be charted up to this far ahead of the server clock (device clock skew). */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000

export interface NursingVitalsRequest {
  /** When the reading was taken; absent = now. */
  recordedAt?: Date
  reading: VitalsInput
}

/**
 * The nursing vitals body: the WS1 reading fields plus an optional `recordedAt` (an instant with an
 * explicit UTC offset, not more than 5 minutes in the future). Strict: unknown keys are refused by
 * the reading schema. `now` is a parameter so the future rule is testable.
 */
export function nursingVitalsSchema(now: Date = new Date()) {
  const recordedAtSchema = appointmentInstantSchema.refine(
    (s) => new Date(s).getTime() <= now.getTime() + MAX_FUTURE_SKEW_MS,
    { message: 'Charting time is in the future' },
  )
  return z.object({ recordedAt: recordedAtSchema.optional() }).loose().transform((body, ctx): NursingVitalsRequest => {
    const { recordedAt, ...rest } = body
    const reading = vitalsInputSchema.safeParse(rest)
    if (!reading.success) {
      for (const issue of reading.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message })
      return z.NEVER
    }
    return { recordedAt: recordedAt === undefined ? undefined : new Date(recordedAt), reading: reading.data }
  })
}

export type VitalWarning = 'fever' | 'hypothermia' | 'tachycardia' | 'bradycardia' | 'hypotension' | 'hypertension' | 'hypoxia' | 'tachypnoea'

export type WarningInput = Pick<VitalsColumns, 'systolicMmhg' | 'diastolicMmhg' | 'pulseBpm' | 'tempDeciC' | 'spo2Pct' | 'respRate'>

/** Ward warning chips for one stored reading (temperature in deci-°C). */
export function vitalWarnings(v: WarningInput): VitalWarning[] {
  const out: VitalWarning[] = []
  if (v.tempDeciC != null && v.tempDeciC >= 380) out.push('fever')
  if (v.tempDeciC != null && v.tempDeciC < 350) out.push('hypothermia')
  if (v.pulseBpm != null && v.pulseBpm > 100) out.push('tachycardia')
  if (v.pulseBpm != null && v.pulseBpm < 50) out.push('bradycardia')
  if (v.systolicMmhg != null && v.systolicMmhg < 90) out.push('hypotension')
  if ((v.systolicMmhg != null && v.systolicMmhg >= 180) || (v.diastolicMmhg != null && v.diastolicMmhg >= 110)) out.push('hypertension')
  if (v.spo2Pct != null && v.spo2Pct < 94) out.push('hypoxia')
  if (v.respRate != null && v.respRate > 24) out.push('tachypnoea')
  return out
}
