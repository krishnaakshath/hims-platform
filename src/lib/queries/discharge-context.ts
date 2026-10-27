// WS3 T6: what the discharge dialog pre-fills (spec 3.2 items 13-14): the stay's diagnoses from
// the admission's IPD encounter (provisional and coded, voided excluded), the drug list from the
// MAR (distinct medication + dose given or scheduled in the last 24 h) and the dues with billing's
// latest clearance. Read-only; the dialog keeps everything editable.
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { diagnoses, encounters, medicationAdministrations } from '@/db/schema'
import type { DischargeDues } from '@/lib/inpatient/dues'
import { loadAdmissionDues, type ClearanceRow } from './admission-dues'
import { liveDiagnosis } from './diagnoses'

export type MarStatus = 'scheduled' | 'given' | 'held' | 'refused'

export interface DischargeContext {
  diagnoses: { codeId: number | null; code: string; display: string; type: 'provisional' | 'primary' | 'secondary' }[]
  medications: { name: string; dose: string; lastStatus: MarStatus }[]
  dues: DischargeDues
  latestClearance: ClearanceRow | null
  unpostedRoomRentDays: number
}

const MAR_WINDOW_MS = 24 * 60 * 60 * 1000
const DISCHARGE_DRUG_STATUSES: readonly MarStatus[] = ['scheduled', 'given']

/** The MAR rows of the window reduced to one entry per (medication, dose), sorted by name then dose. */
export function dischargeMedications(
  rows: { medicationName: string; dose: string; scheduledFor: Date; status: MarStatus }[], now: Date,
): DischargeContext['medications'] {
  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = `${r.medicationName}\u0000${r.dose}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const out: DischargeContext['medications'] = []
  for (const g of groups.values()) {
    // Only a drug still given or due belongs on the discharge list.
    if (!g.some((r) => DISCHARGE_DRUG_STATUSES.includes(r.status))) continue
    // Last status: the latest dose due by now; a drug with only upcoming doses is 'scheduled'.
    const due = g.filter((r) => r.scheduledFor.getTime() <= now.getTime()).sort((a, b) => b.scheduledFor.getTime() - a.scheduledFor.getTime())
    out.push({ name: g[0].medicationName, dose: g[0].dose, lastStatus: due[0]?.status ?? 'scheduled' })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.dose.localeCompare(b.dose))
}

export async function loadDischargeContext(admissionId: number, now: Date = new Date()): Promise<DischargeContext | null> {
  const db = getDb()
  const loaded = await loadAdmissionDues(admissionId, db, now)
  if (!loaded) return null

  const [encounter] = await db.select({ id: encounters.id }).from(encounters)
    .where(and(eq(encounters.admissionId, admissionId), eq(encounters.encounterType, 'ipd'))).limit(1)
  const diagnosisRows = encounter
    ? await db.select({ codeId: diagnoses.codeId, code: diagnoses.code, codeDisplay: diagnoses.codeDisplay, description: diagnoses.description, type: diagnoses.diagnosisType })
      .from(diagnoses)
      .where(and(eq(diagnoses.encounterId, encounter.id), liveDiagnosis, inArray(diagnoses.diagnosisType, ['provisional', 'primary', 'secondary'])))
      .orderBy(sql`(${diagnoses.diagnosisType} = 'primary') DESC`, asc(diagnoses.id))
    : []

  const marRows = await db.select({
    medicationName: medicationAdministrations.medicationName, dose: medicationAdministrations.dose,
    scheduledFor: medicationAdministrations.scheduledFor, status: medicationAdministrations.status,
  }).from(medicationAdministrations)
    .where(and(eq(medicationAdministrations.admissionId, admissionId), gte(medicationAdministrations.scheduledFor, new Date(now.getTime() - MAR_WINDOW_MS))))

  return {
    diagnoses: diagnosisRows.map((d) => ({
      codeId: d.codeId,
      code: d.code,
      display: d.codeDisplay || d.description,
      type: d.type as 'provisional' | 'primary' | 'secondary', // filtered to these three above
    })),
    medications: dischargeMedications(marRows, now),
    dues: loaded.dues,
    latestClearance: loaded.latestClearance,
    unpostedRoomRentDays: loaded.unpostedRoomRentDays,
  }
}
