import { getDb } from '@/db/client'
import { adverseEvents, drugAccountabilityEntries, regulatoryDocuments, patients } from '@/db/schema'
import { and, eq, desc, isNull } from 'drizzle-orm'

export interface AdverseEventRow {
  id: number
  patientId: string
  patientName: string
  description: string
  severity: 'mild' | 'moderate' | 'severe'
  serious: boolean
  causality: 'unrelated' | 'unlikely' | 'possibly' | 'probably' | 'definitely'
  outcome: 'resolved' | 'resolving' | 'ongoing' | 'fatal' | 'unknown'
  onsetDate: string
  reportedDate: string
  reportedByName: string
  sponsorNotifiedAt: Date | null
  irbNotifiedAt: Date | null
}

export async function listAdverseEvents(trialId: string): Promise<AdverseEventRow[]> {
  const rows = await getDb()
    .select({
      id: adverseEvents.id,
      patientId: adverseEvents.patientId,
      patientName: patients.name,
      description: adverseEvents.description,
      severity: adverseEvents.severity,
      serious: adverseEvents.serious,
      causality: adverseEvents.causality,
      outcome: adverseEvents.outcome,
      onsetDate: adverseEvents.onsetDate,
      reportedDate: adverseEvents.reportedDate,
      reportedByName: adverseEvents.reportedByName,
      sponsorNotifiedAt: adverseEvents.sponsorNotifiedAt,
      irbNotifiedAt: adverseEvents.irbNotifiedAt,
    })
    .from(adverseEvents)
    .leftJoin(patients, eq(patients.id, adverseEvents.patientId))
    .where(eq(adverseEvents.trialId, trialId))
    .orderBy(desc(adverseEvents.reportedDate), desc(adverseEvents.id))
  // patients.name is NOT NULL and adverseEvents.patientId is a NOT NULL FK to
  // it, so this left-join miss never actually happens -- the fallback exists
  // only to satisfy the join's nullable TS type.
  return rows.map((r) => ({ ...r, patientName: r.patientName ?? r.patientId }))
}

export async function createAdverseEvent(input: {
  trialId: string
  patientId: string
  description: string
  severity: 'mild' | 'moderate' | 'severe'
  serious: boolean
  causality: 'unrelated' | 'unlikely' | 'possibly' | 'probably' | 'definitely'
  onsetDate: string
  reportedDate: string
  reportedByName: string
}) {
  const [created] = await getDb().insert(adverseEvents).values(input).returning()
  return created
}

/**
 * Records a sponsor/IRB notification time, once. Scoped to `trialId` when
 * given (the route always passes it), so an id from another trial is
 * 'not_found'; a notification already recorded is left untouched.
 */
export async function markAdverseEventNotified(id: number, which: 'sponsor' | 'irb', trialId?: string): Promise<'notified' | 'not_found' | 'already_notified'> {
  const scope = trialId === undefined ? eq(adverseEvents.id, id) : and(eq(adverseEvents.id, id), eq(adverseEvents.trialId, trialId))
  const column = which === 'sponsor' ? adverseEvents.sponsorNotifiedAt : adverseEvents.irbNotifiedAt
  const updated = await getDb().update(adverseEvents)
    .set(which === 'sponsor' ? { sponsorNotifiedAt: new Date() } : { irbNotifiedAt: new Date() })
    .where(and(scope, isNull(column)))
    .returning({ id: adverseEvents.id })
  if (updated.length > 0) return 'notified'
  const [existing] = await getDb().select({ id: adverseEvents.id }).from(adverseEvents).where(scope)
  return existing ? 'already_notified' : 'not_found'
}

export interface DrugAccountabilityRow {
  id: number
  patientId: string | null
  patientName: string | null
  lotNumber: string
  expirationDate: string
  action: 'received' | 'dispensed' | 'returned' | 'destroyed'
  quantity: number
  performedByName: string
  date: string
  notes: string | null
}

export async function listDrugAccountability(trialId: string): Promise<DrugAccountabilityRow[]> {
  const rows = await getDb()
    .select({
      id: drugAccountabilityEntries.id,
      patientId: drugAccountabilityEntries.patientId,
      patientName: patients.name,
      lotNumber: drugAccountabilityEntries.lotNumber,
      expirationDate: drugAccountabilityEntries.expirationDate,
      action: drugAccountabilityEntries.action,
      quantity: drugAccountabilityEntries.quantity,
      performedByName: drugAccountabilityEntries.performedByName,
      date: drugAccountabilityEntries.date,
      notes: drugAccountabilityEntries.notes,
    })
    .from(drugAccountabilityEntries)
    .leftJoin(patients, eq(patients.id, drugAccountabilityEntries.patientId))
    .where(eq(drugAccountabilityEntries.trialId, trialId))
    .orderBy(desc(drugAccountabilityEntries.date), desc(drugAccountabilityEntries.id))
  return rows
}

// received + dispensed-back-in-error (none here) - dispensed - returned -
// destroyed = on hand. "returned" means a participant returned unused
// units to the site, so it adds back to on-hand, same as "received".
export function drugOnHand(entries: DrugAccountabilityRow[]): number {
  return entries.reduce((total, e) => {
    if (e.action === 'received' || e.action === 'returned') return total + e.quantity
    return total - e.quantity
  }, 0)
}

export async function createDrugAccountabilityEntry(input: {
  trialId: string
  patientId: string | null
  lotNumber: string
  expirationDate: string
  action: 'received' | 'dispensed' | 'returned' | 'destroyed'
  quantity: number
  performedByName: string
  date: string
  notes?: string
}) {
  const [created] = await getDb().insert(drugAccountabilityEntries).values(input).returning()
  return created
}

export interface RegulatoryDocumentRow {
  id: number
  documentType: 'form_1572' | 'delegation_log' | 'irb_approval' | 'informed_consent_template' | 'protocol' | 'investigator_brochure' | 'other'
  title: string
  version: string | null
  effectiveDate: string
  expirationDate: string | null
  status: 'current' | 'expired' | 'superseded'
  uploadedByName: string
  uploadedAt: Date
}

export async function listRegulatoryDocuments(trialId: string): Promise<RegulatoryDocumentRow[]> {
  return getDb()
    .select()
    .from(regulatoryDocuments)
    .where(eq(regulatoryDocuments.trialId, trialId))
    .orderBy(desc(regulatoryDocuments.effectiveDate), desc(regulatoryDocuments.id))
}

export async function createRegulatoryDocument(input: {
  trialId: string
  documentType: 'form_1572' | 'delegation_log' | 'irb_approval' | 'informed_consent_template' | 'protocol' | 'investigator_brochure' | 'other'
  title: string
  version?: string
  effectiveDate: string
  expirationDate?: string
  uploadedByName: string
}) {
  const [created] = await getDb().insert(regulatoryDocuments).values(input).returning()
  return created
}
