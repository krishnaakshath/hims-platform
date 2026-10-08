// SP7: patient insurance policies and policy-card images, the primary-payer mirror (ruling 6),
// the legacy prefill and the RCM patient search. Card blob URLs never leave the server; audit
// details carry ids and enum values only (never policy or member numbers).
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import { patientPolicies, patients, payerProfiles, payers, type PatientPolicyRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import { isUniqueViolation } from '@/lib/db-errors'
import { ageOnDate, todayIsoIn } from '@/lib/india-time'
import { putPrivateBlob } from '@/lib/blob-store'
import { INSURER_SIDE_KINDS, type PayerKind, type PolicyPriority, type PolicyRelationship, type PolicyStatus, type PolicyType } from '@/lib/rcm/constants'
import { rcmFail, rcmOk, type RcmWriteResult } from '@/lib/rcm/errors'
import { sha256Hex } from '@/lib/rcm/hash'
import type { PolicyInput, PolicyPatchInput } from '@/lib/rcm/validation'
import type { WriteExecutor } from './executor'

// ---- RCM patient search (the RCM minimum: no phone, email, address or identity numbers) ----

export interface RcmPatientHit { id: string; name: string; uhid: string | null; gender: string | null; ageYears: number | null }

export async function findPatientsForRcm(q: string, now: Date = new Date()): Promise<RcmPatientHit[]> {
  const term = q.trim()
  if (term.length < 2) return []
  const cols = { id: patients.id, name: patients.name, uhid: patients.uhid, gender: patients.gender, dob: patients.dob }
  const db = getDb()
  const exact = await db.select(cols).from(patients).where(or(sql`upper(${patients.uhid}) = upper(${term})`, eq(patients.id, term))).limit(10)
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`)
  const byName = await db.select(cols).from(patients).where(ilike(patients.name, `${escaped}%`)).orderBy(asc(patients.name), asc(patients.id)).limit(10)
  const seen = new Set<string>()
  const today = todayIsoIn(undefined, now)
  const out: RcmPatientHit[] = []
  for (const p of [...exact, ...byName]) {
    if (seen.has(p.id) || out.length >= 10) continue
    seen.add(p.id)
    out.push({ id: p.id, name: p.name, uhid: p.uhid, gender: p.gender, ageYears: p.dob ? ageOnDate(p.dob, today) : null })
  }
  return out
}

// ---- policy views ---------------------------------------------------------------------------

export interface PolicyView {
  id: number; patientId: string
  insurer: { payerId: number; name: string }; tpa: { payerId: number; name: string } | null
  policyNumber: string; memberId: string; planName: string | null; policyType: PolicyType; corporateName: string | null
  holderName: string; relationship: PolicyRelationship; validFrom: string; validTo: string
  sumInsuredPaise: number | null; copayBp: number | null; roomRentLimitPaise: number | null
  priority: PolicyPriority; status: PolicyStatus; hasCardFront: boolean; hasCardBack: boolean
}

const insurerPayer = alias(payers, 'insurer_payer')
const tpaPayer = alias(payers, 'tpa_payer')

function toView(p: PatientPolicyRow, insurerName: string, tpaName: string | null): PolicyView {
  return {
    id: p.id, patientId: p.patientId,
    insurer: { payerId: p.insurerPayerId, name: insurerName },
    tpa: p.tpaPayerId === null ? null : { payerId: p.tpaPayerId, name: tpaName ?? '' },
    policyNumber: p.policyNumber, memberId: p.memberId, planName: p.planName, policyType: p.policyType, corporateName: p.corporateName,
    holderName: p.holderName, relationship: p.relationship, validFrom: p.validFrom, validTo: p.validTo,
    sumInsuredPaise: p.sumInsuredPaise, copayBp: p.copayBp, roomRentLimitPaise: p.roomRentLimitPaise,
    priority: p.priority, status: p.status, hasCardFront: p.cardFrontBlobUrl !== null, hasCardBack: p.cardBackBlobUrl !== null,
  }
}

/** A patient's policies, active first, then primary first, then newest. No blob URLs. */
export async function listPatientPolicies(patientId: string, executor: WriteExecutor = getDb()): Promise<PolicyView[]> {
  const rows = await executor
    .select({ p: patientPolicies, insurerName: insurerPayer.name, tpaName: tpaPayer.name })
    .from(patientPolicies)
    .innerJoin(insurerPayer, eq(insurerPayer.id, patientPolicies.insurerPayerId))
    .leftJoin(tpaPayer, eq(tpaPayer.id, patientPolicies.tpaPayerId))
    .where(eq(patientPolicies.patientId, patientId))
    .orderBy(asc(patientPolicies.status), asc(patientPolicies.priority), desc(patientPolicies.id))
  return rows.map((r) => toView(r.p, r.insurerName, r.tpaName))
}

export async function getPolicyView(policyId: number, executor: WriteExecutor = getDb()): Promise<PolicyView | null> {
  const [r] = await executor
    .select({ p: patientPolicies, insurerName: insurerPayer.name, tpaName: tpaPayer.name })
    .from(patientPolicies)
    .innerJoin(insurerPayer, eq(insurerPayer.id, patientPolicies.insurerPayerId))
    .leftJoin(tpaPayer, eq(tpaPayer.id, patientPolicies.tpaPayerId))
    .where(eq(patientPolicies.id, policyId)).limit(1)
  return r ? toView(r.p, r.insurerName, r.tpaName) : null
}

/** The payer SP4 bills: the TPA when there is one, else the insurer. */
export function billingPayerOf(p: { insurerPayerId: number; tpaPayerId: number | null }): number {
  return p.tpaPayerId ?? p.insurerPayerId
}

// ---- writes ---------------------------------------------------------------------------------

/** The insurer field takes an insurer-side profile, the TPA field a TPA profile; both active. */
async function checkPayers(executor: WriteExecutor, insurerPayerId: number, tpaPayerId: number | null): Promise<RcmWriteResult<null>> {
  const ids = tpaPayerId === null ? [insurerPayerId] : [insurerPayerId, tpaPayerId]
  const rows = await executor.select({ id: payerProfiles.payerId, kind: payerProfiles.kind, active: payerProfiles.active })
    .from(payerProfiles).where(inArray(payerProfiles.payerId, ids))
  const byId = new Map<number, { kind: PayerKind; active: boolean }>(rows.map((r) => [r.id, r]))
  const insurer = byId.get(insurerPayerId)
  const tpa = tpaPayerId === null ? null : byId.get(tpaPayerId)
  if (!insurer || !INSURER_SIDE_KINDS.includes(insurer.kind)) return rcmFail('payer_kind_invalid')
  if (tpaPayerId !== null && (!tpa || tpa.kind !== 'tpa')) return rcmFail('payer_kind_invalid')
  if (!insurer.active || (tpa && !tpa.active)) return rcmFail('payer_inactive')
  return rcmOk(null)
}

const isActivePrimary = (p: { status: PolicyStatus; priority: PolicyPriority }) => p.status === 'active' && p.priority === 'primary'

export async function createPolicy(input: PolicyInput, session: Session): Promise<RcmWriteResult<{ policyId: number }>> {
  let result: RcmWriteResult<{ policyId: number }>
  try {
    result = await getDb().transaction(async (tx) => {
      const [patient] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, input.patientId)).for('update')
      if (!patient) return rcmFail('patient_not_found')
      const tpaPayerId = input.tpaPayerId ?? null
      const payerCheck = await checkPayers(tx, input.insurerPayerId, tpaPayerId)
      if (!payerCheck.ok) return payerCheck
      const [row] = await tx.insert(patientPolicies).values({
        patientId: input.patientId, insurerPayerId: input.insurerPayerId, tpaPayerId, policyNumber: input.policyNumber, memberId: input.memberId,
        planName: input.planName ?? null, policyType: input.policyType, corporateName: input.corporateName ?? null, employeeId: input.employeeId ?? null,
        holderName: input.holderName, relationship: input.relationship, validFrom: input.validFrom, validTo: input.validTo,
        sumInsuredPaise: input.sumInsuredPaise ?? null, copayBp: input.copayBp ?? null, roomRentLimitPaise: input.roomRentLimitPaise ?? null,
        priority: input.priority, status: input.status, createdByName: session.name, updatedByName: session.name,
      }).returning({ id: patientPolicies.id })
      if (isActivePrimary(input)) {
        await tx.update(patients).set({ primaryPayerId: billingPayerOf({ insurerPayerId: input.insurerPayerId, tpaPayerId }) }).where(eq(patients.id, input.patientId))
      }
      await logAudit(session, 'rcm: added policy', input.patientId, `policy=${row.id} insurer=${input.insurerPayerId} tpa=${tpaPayerId ?? 'none'} priority=${input.priority}`, tx)
      return rcmOk({ policyId: row.id })
    })
  } catch (err) {
    if (isUniqueViolation(err, 'patient_policies_one_active_primary')) return rcmFail('primary_exists')
    throw err
  }
  if (result.ok) await invalidateCache(patientDetailCacheKey(input.patientId))
  return result
}

const PATCH_KEYS = [
  'insurerPayerId', 'tpaPayerId', 'policyNumber', 'memberId', 'planName', 'policyType', 'corporateName', 'employeeId', 'holderName',
  'relationship', 'validFrom', 'validTo', 'sumInsuredPaise', 'copayBp', 'roomRentLimitPaise', 'priority', 'status',
] as const satisfies readonly (keyof PolicyPatchInput & keyof PatientPolicyRow)[]

export async function updatePolicy(policyId: number, patch: PolicyPatchInput, session: Session): Promise<RcmWriteResult<null>> {
  const [found] = await getDb().select({ patientId: patientPolicies.patientId }).from(patientPolicies).where(eq(patientPolicies.id, policyId)).limit(1)
  if (!found) return rcmFail('policy_not_found')
  let result: RcmWriteResult<null>
  try {
    result = await getDb().transaction(async (tx) => {
      // Lock order: the patient row, then the policy row (as createPolicy).
      await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, found.patientId)).for('update')
      const [before] = await tx.select().from(patientPolicies).where(eq(patientPolicies.id, policyId)).for('update')
      if (!before) return rcmFail('policy_not_found')
      const next: PatientPolicyRow = { ...before }
      const changed: string[] = []
      for (const k of PATCH_KEYS) {
        if (!(k in patch)) continue
        const v = (patch as Record<string, unknown>)[k] ?? null
        if (String(before[k] ?? '') !== String(v ?? '')) changed.push(k)
        ;(next as Record<string, unknown>)[k] = v
      }
      if (next.validTo < next.validFrom) return rcmFail('amounts_invalid', 'The policy end date is before its start')
      if (next.policyType === 'group_corporate' && !next.corporateName) return rcmFail('amounts_invalid', 'Enter the employer for a corporate policy')
      const payerCheck = await checkPayers(tx, next.insurerPayerId, next.tpaPayerId)
      if (!payerCheck.ok) return payerCheck
      const set: Partial<PatientPolicyRow> = { updatedAt: new Date(), updatedByName: session.name }
      for (const k of PATCH_KEYS) (set as Record<string, unknown>)[k] = next[k]
      await tx.update(patientPolicies).set(set).where(eq(patientPolicies.id, policyId))
      // Ruling 6: the active primary policy mirrors its billing payer into patients.primary_payer_id.
      const oldPayer = billingPayerOf(before)
      if (isActivePrimary(next)) {
        await tx.update(patients).set({ primaryPayerId: billingPayerOf(next) }).where(eq(patients.id, before.patientId))
      } else if (isActivePrimary(before)) {
        await tx.update(patients).set({ primaryPayerId: null }).where(and(eq(patients.id, before.patientId), eq(patients.primaryPayerId, oldPayer)))
      }
      await logAudit(session, 'rcm: updated policy', before.patientId, `policy=${policyId} fields=${changed.sort().join(',')}`, tx)
      return rcmOk(null)
    })
  } catch (err) {
    if (isUniqueViolation(err, 'patient_policies_one_active_primary')) return rcmFail('primary_exists')
    throw err
  }
  if (result.ok) await invalidateCache(patientDetailCacheKey(found.patientId))
  return result
}

const EXTENSION: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }

/** Stores a card image: hash and private blob put happen before the transaction (a failed put writes nothing). */
export async function uploadPolicyCard(
  policyId: number, side: 'front' | 'back', file: { bytes: Uint8Array; contentType: string }, session: Session,
): Promise<RcmWriteResult<null>> {
  const [found] = await getDb().select({ patientId: patientPolicies.patientId }).from(patientPolicies).where(eq(patientPolicies.id, policyId)).limit(1)
  if (!found) return rcmFail('policy_not_found')
  const ext = EXTENSION[file.contentType]
  if (!ext) return rcmFail('upload_invalid')
  const sha256 = sha256Hex(file.bytes)
  const { url } = await putPrivateBlob(`rcm/policies/${policyId}/${randomUUID()}.${ext}`, file.bytes, file.contentType)
  return getDb().transaction(async (tx) => {
    const [row] = await tx.select({ id: patientPolicies.id }).from(patientPolicies).where(eq(patientPolicies.id, policyId)).for('update')
    if (!row) return rcmFail('policy_not_found')
    const set = side === 'front' ? { cardFrontBlobUrl: url, cardFrontSha256: sha256 } : { cardBackBlobUrl: url, cardBackSha256: sha256 }
    await tx.update(patientPolicies).set({ ...set, updatedAt: new Date(), updatedByName: session.name }).where(eq(patientPolicies.id, policyId))
    await logAudit(session, 'rcm: uploaded policy card', found.patientId, `policy=${policyId} side=${side}`, tx)
    return rcmOk(null)
  })
}

/** Server-side only: the stored card blob (never returned in JSON). */
export async function getPolicyCardBlob(policyId: number, side: 'front' | 'back'): Promise<{ url: string; patientId: string; contentType: string } | null> {
  const [row] = await getDb().select({ patientId: patientPolicies.patientId, front: patientPolicies.cardFrontBlobUrl, back: patientPolicies.cardBackBlobUrl })
    .from(patientPolicies).where(eq(patientPolicies.id, policyId)).limit(1)
  const url = row ? (side === 'front' ? row.front : row.back) : null
  if (!row || !url) return null
  const ext = url.split('.').pop()?.toLowerCase()
  const contentType = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg'
  return { url, patientId: row.patientId, contentType }
}

/**
 * A policy-form prefill from the legacy US-style insurance columns. Read-only; null when they are
 * empty. The legacy payer is used only when it has an insurer/TPA profile.
 */
export async function legacyPolicyPrefill(patientId: string): Promise<Partial<PolicyInput> | null> {
  const [p] = await getDb().select({
    payerId: patients.primaryPayerId, memberId: patients.primaryMemberId, holder: patients.primarySubscriberName, relationship: patients.primarySubscriberRelationship,
  }).from(patients).where(eq(patients.id, patientId)).limit(1)
  if (!p || (p.payerId === null && !p.memberId && !p.holder && p.relationship === null)) return null
  const out: Partial<PolicyInput> = {}
  if (p.payerId !== null) {
    const [profile] = await getDb().select({ kind: payerProfiles.kind }).from(payerProfiles).where(eq(payerProfiles.payerId, p.payerId)).limit(1)
    if (profile?.kind === 'tpa') out.tpaPayerId = p.payerId
    else if (profile && INSURER_SIDE_KINDS.includes(profile.kind)) out.insurerPayerId = p.payerId
  }
  if (p.memberId) out.memberId = p.memberId
  if (p.holder) out.holderName = p.holder
  if (p.relationship) out.relationship = p.relationship
  return out
}
