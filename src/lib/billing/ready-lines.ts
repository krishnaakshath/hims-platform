// WS2 T12 (pure): which captured, uninvoiced charge lines "Invoice all ready lines" may draft, and
// how they group into draft invoices. Spec ruling 12:
//   - a line on an admission is ready once the stay is discharged (else it waits: still_admitted);
//   - otherwise a line on a visit is ready once an OPD (or IPD) visit is completed (else it waits:
//     visit_open); a lab-type visit is ready in any open status;
//   - a line with neither (a pharmacy line with no visit or stay) is always ready.
// A line on a cancelled visit is neither ready nor waiting (automatic lines are voided with the
// visit; a manual one left there needs a clerk's decision on Charge Capture).
// Groups follow createDraftInvoice's rule: one patient, one payer (null = self-pay), one context
// (the admission when the line has one, else the visit, else none).

export interface ReadyLineInput {
  id: number
  patientId: string
  payerId: number | null
  encounterId: number | null
  admissionId: number | null
  encounterType: 'opd' | 'ipd' | 'lab' | null
  encounterStatus: 'checked_in' | 'in_consultation' | 'completed' | 'cancelled' | null
  admissionStatus: 'admitted' | 'discharged' | null
}

export interface ReadyGroup { patientId: string; payerId: number | null; admissionId: number | null; encounterId: number | null; lineIds: number[] }

export type WaitReason = 'visit_open' | 'still_admitted'

/** 'ready', a wait reason, or null (neither: cancelled visit or a context row that is missing). */
export function lineReadiness(l: ReadyLineInput): 'ready' | WaitReason | null {
  if (l.admissionId !== null) {
    if (l.admissionStatus === 'discharged') return 'ready'
    return l.admissionStatus === 'admitted' ? 'still_admitted' : null
  }
  if (l.encounterId !== null) {
    if (l.encounterType === null || l.encounterStatus === null || l.encounterStatus === 'cancelled') return null
    if (l.encounterType === 'lab') return 'ready'
    return l.encounterStatus === 'completed' ? 'ready' : 'visit_open'
  }
  return 'ready'
}

export function groupReadyLines(lines: ReadyLineInput[]): { groups: ReadyGroup[]; waiting: { lineId: number; why: WaitReason }[] } {
  const sorted = [...lines].sort((a, b) => a.id - b.id)
  const groups = new Map<string, ReadyGroup>()
  const waiting: { lineId: number; why: WaitReason }[] = []
  for (const l of sorted) {
    const r = lineReadiness(l)
    if (r === null) continue
    if (r !== 'ready') { waiting.push({ lineId: l.id, why: r }); continue }
    const context = l.admissionId !== null ? `adm:${l.admissionId}` : l.encounterId !== null ? `enc:${l.encounterId}` : 'none'
    const key = JSON.stringify([l.patientId, l.payerId, context])
    const g = groups.get(key)
    if (g) g.lineIds.push(l.id)
    else {
      groups.set(key, {
        patientId: l.patientId, payerId: l.payerId, admissionId: l.admissionId,
        encounterId: l.admissionId === null ? l.encounterId : null, lineIds: [l.id],
      })
    }
  }
  return { groups: [...groups.values()], waiting }
}
