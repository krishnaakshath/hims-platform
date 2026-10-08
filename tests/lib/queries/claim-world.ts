// SP7 test world for claim DB tests: a pre-auth world (patient, insurer + TPA, policy, OPD
// encounter, services, codes) whose patient bills the TPA, finalised SP4 invoices numbered in the
// test financial year 2099-00, and finalised SP6 coding. Destroy with destroyClaimWorld.
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { billingSettings, encounterCoding, patients } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { captureChargeLine } from '@/lib/queries/charge-capture'
import { createDraftInvoice, finaliseInvoice } from '@/lib/queries/invoices'
import { purgeRcmFixtures } from '../../db/rcm-fixtures'
import { purgeBillingFixtures } from '../../db/billing-fixtures'
import { makePreauthWorld, destroyPreauthWorld, type PreauthWorld } from './preauth-world'

export const BILLING_SESSION: Session = { role: 'billing', name: 'TEST-SP7 Billing', userId: null }
export const FINALISE_NOW = new Date('2099-06-01T06:00:00Z')
const CAPTURE_NOW = new Date('2026-10-02T06:00:00Z')

export interface ClaimWorld extends PreauthWorld { savedSettings: Record<string, unknown> | null }

export async function makeClaimWorld(run: string, suffix: string): Promise<ClaimWorld> {
  const w = await makePreauthWorld(run, suffix)
  const db = getDb()
  await db.update(patients).set({ primaryPayerId: w.tpaId }).where(eq(patients.id, w.patientId))
  const [s] = await db.select().from(billingSettings).where(eq(billingSettings.id, 1))
  await db.update(billingSettings).set({ legalName: 'Test SP7 Hospital', stateCode: 'IN-KA', gstin: null, ipdDepositThresholdPaise: 0, consultationWindowDays: 30 }).where(eq(billingSettings.id, 1))
  return { ...w, savedSettings: s ?? null }
}

/** One captured line of the priced service (₹50,000 × qty), drafted and finalised. Returns the invoice id. */
export async function finalisedInvoice(w: ClaimWorld, opts: { billTo?: 'payer' | 'patient'; quantity?: number; finalise?: boolean } = {}): Promise<number> {
  const line = await captureChargeLine({
    context: { encounterId: w.encounterId }, serviceId: w.pricedServiceId, quantity: opts.quantity ?? 1, serviceDate: '2026-10-01', billTo: opts.billTo ?? 'payer',
    overrides: [{ code: 'duplicate_charge', reason: 'test fixture line' }],
  }, BILLING_SESSION, CAPTURE_NOW)
  if (!line.ok) throw new Error(`capture ${line.error} ${JSON.stringify(line.violations ?? [])}`)
  const draft = await createDraftInvoice([line.line.id], BILLING_SESSION)
  if (!draft.ok) throw new Error(`draft ${draft.error}`)
  if (opts.finalise === false) return draft.invoiceId
  const fin = await finaliseInvoice(draft.invoiceId, BILLING_SESSION, FINALISE_NOW)
  if (!fin.ok) throw new Error(`finalise ${fin.error}`)
  return draft.invoiceId
}

export async function finaliseCoding(w: ClaimWorld, status: 'finalised' | 'in_progress' = 'finalised'): Promise<void> {
  const v = { encounterId: w.encounterId, patientId: w.patientId, status, finalisedAt: status === 'finalised' ? new Date() : null, finalisedByName: status === 'finalised' ? 'TEST-SP7' : null }
  await getDb().insert(encounterCoding).values(v).onConflictDoUpdate({ target: encounterCoding.encounterId, set: v })
}

export async function destroyClaimWorld(w: ClaimWorld): Promise<void> {
  await purgeRcmFixtures([w.patientId], [])
  await purgeBillingFixtures([w.patientId])
  await destroyPreauthWorld(w)
  if (w.savedSettings) await getDb().update(billingSettings).set(w.savedSettings).where(eq(billingSettings.id, 1))
}
