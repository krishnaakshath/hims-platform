// SP7: the shared loaders behind pre-auth and claim snapshots — the hospital block, the policy
// block (insurer and TPA references) and the RCM-minimum patient source. Every patients read
// names its columns (ruling 9: no contact, address or identity-number fields).
import { eq, inArray } from 'drizzle-orm'
import { patientPolicies, patients, payerProfiles, payers } from '@/db/schema'
import { getBillingSettings } from './billing-settings'
import type { WriteExecutor } from './executor'
import type { PayerRef, SnapshotHospital, SnapshotPolicy } from '@/lib/rcm/snapshot'

export async function loadSnapshotHospital(executor: WriteExecutor): Promise<SnapshotHospital> {
  const s = await getBillingSettings(executor)
  return { legalName: s.legalName ?? '', gstin: s.gstin, stateCode: s.stateCode, rohiniId: s.rohiniId, hfrId: s.hfrId }
}

export interface PolicyContext {
  policy: SnapshotPolicy
  row: { id: number; patientId: string; insurerPayerId: number; tpaPayerId: number | null; status: 'active' | 'inactive'; validFrom: string; validTo: string; sumInsuredPaise: number | null }
  billingPayerId: number
  /** The billing payer's profile (the TPA's when there is one, else the insurer's). */
  billingProfile: { requiresAbha: boolean; active: boolean } | null
  payersActive: boolean
}

export async function loadPolicyContext(executor: WriteExecutor, policyId: number): Promise<PolicyContext | null> {
  const [p] = await executor.select().from(patientPolicies).where(eq(patientPolicies.id, policyId)).limit(1)
  if (!p) return null
  const ids = p.tpaPayerId === null ? [p.insurerPayerId] : [p.insurerPayerId, p.tpaPayerId]
  const rows = await executor.select({
    id: payers.id, name: payers.name, kind: payerProfiles.kind, irdai: payerProfiles.irdaiRegistrationNo, nhcx: payerProfiles.nhcxParticipantCode,
    active: payerProfiles.active, requiresAbha: payerProfiles.requiresAbha,
  }).from(payers).leftJoin(payerProfiles, eq(payerProfiles.payerId, payers.id)).where(inArray(payers.id, ids))
  const byId = new Map(rows.map((r) => [r.id, r]))
  const ref = (id: number): PayerRef => {
    const r = byId.get(id)
    return { payerId: id, name: r?.name ?? '', kind: r?.kind ?? 'insurer', irdaiRegistrationNo: r?.irdai ?? null, nhcxParticipantCode: r?.nhcx ?? null }
  }
  const billingPayerId = p.tpaPayerId ?? p.insurerPayerId
  const billing = byId.get(billingPayerId)
  return {
    policy: {
      insurer: ref(p.insurerPayerId), tpa: p.tpaPayerId === null ? null : ref(p.tpaPayerId), policyNumber: p.policyNumber, memberId: p.memberId,
      planName: p.planName, policyType: p.policyType, holderName: p.holderName, relationship: p.relationship, validFrom: p.validFrom,
      validTo: p.validTo, sumInsuredPaise: p.sumInsuredPaise, corporateName: p.corporateName,
    },
    row: { id: p.id, patientId: p.patientId, insurerPayerId: p.insurerPayerId, tpaPayerId: p.tpaPayerId, status: p.status, validFrom: p.validFrom, validTo: p.validTo, sumInsuredPaise: p.sumInsuredPaise },
    billingPayerId,
    billingProfile: billing && billing.kind !== null ? { requiresAbha: Boolean(billing.requiresAbha), active: Boolean(billing.active) } : null,
    payersActive: ids.every((id) => byId.get(id)?.active === true),
  }
}

/** The RCM minimum of a patient plus the ABHA number (used only when a payer requires it). */
export async function loadRcmPatient(executor: WriteExecutor, patientId: string): Promise<{
  patient: { id: string; uhid: string | null; name: string; gender: string | null; dob: string | null }; abhaNumber: string | null
} | null> {
  const [p] = await executor.select({ id: patients.id, uhid: patients.uhid, name: patients.name, gender: patients.gender, dob: patients.dob, abhaNumber: patients.abhaNumber })
    .from(patients).where(eq(patients.id, patientId)).limit(1)
  if (!p) return null
  return { patient: { id: p.id, uhid: p.uhid, name: p.name, gender: p.gender, dob: p.dob }, abhaNumber: p.abhaNumber }
}
