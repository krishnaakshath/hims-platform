// WS1 T2: the one vitals vocabulary (encounter_vitals is the single vitals table for the product,
// lane ruling R1): request validation, unit conversion to integer storage columns, BMI and flags.
import { z } from 'zod'

export interface VitalsInput {
  systolicMmhg?: number
  diastolicMmhg?: number
  pulseBpm?: number
  tempC?: number
  spo2Pct?: number
  respRate?: number
  weightKg?: number
  heightCm?: number
  painScore?: number // R1: 0..10
  notes?: string // R1: free text, max 300; never audited
}

// A finite number with at most `places` decimals (float-noise tolerant).
function decimal(min: number, max: number, places: number) {
  const scale = 10 ** places
  return z.number().min(min).max(max).refine((n) => Math.abs(n * scale - Math.round(n * scale)) < 1e-6, { message: `at most ${places} decimals` })
}

export const vitalsInputSchema = z.object({
  systolicMmhg: z.number().int().min(50).max(300).optional(),
  diastolicMmhg: z.number().int().min(20).max(200).optional(),
  pulseBpm: z.number().int().min(20).max(250).optional(),
  tempC: decimal(30, 45, 1).optional(),
  spo2Pct: z.number().int().min(50).max(100).optional(),
  respRate: z.number().int().min(4).max(80).optional(),
  weightKg: decimal(0.3, 400, 3).optional(),
  heightCm: decimal(30, 250, 1).optional(),
  painScore: z.number().int().min(0).max(10).optional(),
  notes: z.string().trim().max(300).optional(),
}).strict().superRefine((v, ctx) => {
  const { systolicMmhg, diastolicMmhg, pulseBpm, tempC, spo2Pct, respRate, weightKg, heightCm, painScore } = v
  if ([systolicMmhg, diastolicMmhg, pulseBpm, tempC, spo2Pct, respRate, weightKg, heightCm, painScore].every((x) => x === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Enter at least one measurement' })
  }
  if (v.systolicMmhg !== undefined && v.diastolicMmhg !== undefined && v.diastolicMmhg >= v.systolicMmhg) {
    ctx.addIssue({ code: 'custom', path: ['diastolicMmhg'], message: 'Diastolic must be below systolic' })
  }
}) as z.ZodType<VitalsInput>

export interface VitalsColumns {
  systolicMmhg: number | null
  diastolicMmhg: number | null
  pulseBpm: number | null
  tempDeciC: number | null
  spo2Pct: number | null
  respRate: number | null
  weightG: number | null
  heightMm: number | null
  painScore: number | null
  notes: string | null
}

const scaled = (n: number | undefined, factor: number): number | null => (n === undefined ? null : Math.round(n * factor))

export function toVitalsColumns(i: VitalsInput): VitalsColumns {
  return {
    systolicMmhg: i.systolicMmhg ?? null,
    diastolicMmhg: i.diastolicMmhg ?? null,
    pulseBpm: i.pulseBpm ?? null,
    tempDeciC: scaled(i.tempC, 10),
    spo2Pct: i.spo2Pct ?? null,
    respRate: i.respRate ?? null,
    weightG: scaled(i.weightKg, 1000),
    heightMm: scaled(i.heightCm, 10),
    painScore: i.painScore ?? null,
    notes: i.notes ? i.notes : null,
  }
}

/** BMI x 10 (kg/m2), or null when weight or height is missing. */
export function bmiTenths(weightG: number | null, heightMm: number | null): number | null {
  if (weightG == null || heightMm == null || heightMm <= 0) return null
  return Math.round((10000 * weightG) / (heightMm * heightMm))
}

export type VitalsFlag = 'bp_high' | 'bp_low' | 'fever' | 'spo2_low' | 'tachycardia' | 'bradycardia'

export function vitalsFlags(v: Pick<VitalsColumns, 'systolicMmhg' | 'diastolicMmhg' | 'pulseBpm' | 'tempDeciC' | 'spo2Pct'>): VitalsFlag[] {
  const flags: VitalsFlag[] = []
  if ((v.systolicMmhg != null && v.systolicMmhg >= 140) || (v.diastolicMmhg != null && v.diastolicMmhg >= 90)) flags.push('bp_high')
  if (v.systolicMmhg != null && v.systolicMmhg < 90) flags.push('bp_low')
  if (v.tempDeciC != null && v.tempDeciC >= 380) flags.push('fever')
  if (v.spo2Pct != null && v.spo2Pct < 94) flags.push('spo2_low')
  if (v.pulseBpm != null && v.pulseBpm > 100) flags.push('tachycardia')
  if (v.pulseBpm != null && v.pulseBpm < 50) flags.push('bradycardia')
  return flags
}
