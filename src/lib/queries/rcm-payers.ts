// SP7: the insurer/TPA master on top of `payers` (ruling 6), payer contacts, TPA networks,
// per-payer document requirements, reason codes and the hospital identifiers. Every write runs
// in one transaction with its audit row; audit details carry ids, kinds and counts only.
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  billingSettings, payerContacts, payerDocumentRequirements, payerNetworks, payerProfiles, payers, rcmReasonCodes,
  type PayerContactRow, type PayerDocumentRequirementRow, type PayerProfileRow, type RcmReasonCodeRow,
} from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { INSURER_SIDE_KINDS, type ClaimType, type PayerKind, type ReasonCategory } from '@/lib/rcm/constants'
import { rcmFail, rcmOk, type RcmWriteResult } from '@/lib/rcm/errors'
import type { DocumentRequirementsInput, PayerContactsInput, PayerCreateInput, PayerProfileInput, RcmSettingsInput } from '@/lib/rcm/validation'
import type { WriteExecutor } from './executor'

export interface RcmPayerRow { payerId: number; name: string; code: string; gstin: string | null; stateCode: string | null; profile: PayerProfileRow | null }

export async function listRcmPayers(opts: { kind?: PayerKind; includeInactive?: boolean } = {}): Promise<RcmPayerRow[]> {
  const rows = await getDb()
    .select({ payerId: payers.id, name: payers.name, code: payers.payerId, gstin: payers.gstin, stateCode: payers.stateCode, profile: payerProfiles })
    .from(payers)
    .leftJoin(payerProfiles, eq(payerProfiles.payerId, payers.id))
    .orderBy(asc(payers.name), asc(payers.id))
  return rows.filter((r) => {
    if (opts.kind && r.profile?.kind !== opts.kind) return false
    if (!opts.includeInactive && r.profile && !r.profile.active) return false
    return true
  })
}

export async function getRcmPayer(payerId: number): Promise<(RcmPayerRow & { contacts: PayerContactRow[]; tpaIds: number[]; insurerIds: number[]; requirements: PayerDocumentRequirementRow[] }) | null> {
  const db = getDb()
  const [row] = await db
    .select({ payerId: payers.id, name: payers.name, code: payers.payerId, gstin: payers.gstin, stateCode: payers.stateCode, profile: payerProfiles })
    .from(payers).leftJoin(payerProfiles, eq(payerProfiles.payerId, payers.id)).where(eq(payers.id, payerId)).limit(1)
  if (!row) return null
  const [contacts, asInsurer, asTpa, requirements] = await Promise.all([
    db.select().from(payerContacts).where(eq(payerContacts.payerId, payerId)).orderBy(asc(payerContacts.id)),
    db.select({ id: payerNetworks.tpaPayerId }).from(payerNetworks).where(eq(payerNetworks.insurerPayerId, payerId)),
    db.select({ id: payerNetworks.insurerPayerId }).from(payerNetworks).where(eq(payerNetworks.tpaPayerId, payerId)),
    db.select().from(payerDocumentRequirements).where(eq(payerDocumentRequirements.payerId, payerId)).orderBy(asc(payerDocumentRequirements.id)),
  ])
  return { ...row, contacts, tpaIds: asInsurer.map((r) => r.id).sort((a, b) => a - b), insurerIds: asTpa.map((r) => r.id).sort((a, b) => a - b), requirements }
}

const PROFILE_KEYS = [
  'kind', 'shortName', 'irdaiRegistrationNo', 'nhcxParticipantCode', 'defaultChannel', 'portalUrl', 'claimsEmail', 'empanelmentStatus',
  'empanelledFrom', 'empanelledTo', 'agreementReference', 'preauthSlaHours', 'claimSettlementSlaDays', 'queryResponseDays',
  'submissionWindowDays', 'requiresAbha', 'requiresPreauthForIpd', 'active', 'notes',
] as const satisfies readonly (keyof PayerProfileInput & keyof PayerProfileRow)[]

function profileValues(input: PayerProfileInput) {
  const out: Record<string, unknown> = {}
  for (const k of PROFILE_KEYS) out[k] = input[k] ?? null
  return out as Pick<PayerProfileRow, (typeof PROFILE_KEYS)[number]>
}

export async function createPayerWithProfile(input: PayerCreateInput, session: Session): Promise<RcmWriteResult<{ payerId: number }>> {
  return getDb().transaction(async (tx) => {
    // payers.payer_id has no unique constraint, so the code is checked under one advisory lock.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('rcm:payer-code'))`)
    const [dup] = await tx.select({ id: payers.id }).from(payers).where(sql`upper(${payers.payerId}) = ${input.code}`).limit(1)
    if (dup) return rcmFail('duplicate_reference', 'A payer with this code already exists')
    const [payer] = await tx.insert(payers).values({ name: input.name, payerId: input.code, payerType: 'other', gstin: input.gstin ?? null, stateCode: input.stateCode ?? null }).returning({ id: payers.id })
    await tx.insert(payerProfiles).values({ payerId: payer.id, ...profileValues(input), updatedByName: session.name })
    await logAudit(session, 'rcm: created payer', null, `payer=${payer.id} kind=${input.kind}`, tx)
    return rcmOk({ payerId: payer.id })
  })
}

/** Creates or replaces a payer's profile (new or legacy payer). payers.payer_type is never touched. */
export async function upsertPayerProfile(payerId: number, input: PayerProfileInput, session: Session): Promise<RcmWriteResult<null>> {
  return getDb().transaction(async (tx) => {
    const [payer] = await tx.select({ id: payers.id, gstin: payers.gstin, stateCode: payers.stateCode }).from(payers).where(eq(payers.id, payerId)).for('update')
    if (!payer) return rcmFail('payer_not_found')
    const [before] = await tx.select().from(payerProfiles).where(eq(payerProfiles.payerId, payerId)).for('update')
    const values = profileValues(input)
    const changed: string[] = PROFILE_KEYS.filter((k) => !before || String(before[k] ?? '') !== String(values[k] ?? ''))
    const gstin = input.gstin ?? null
    const stateCode = input.stateCode ?? null
    if (payer.gstin !== gstin) changed.push('gstin')
    if (payer.stateCode !== stateCode) changed.push('stateCode')
    await tx.update(payers).set({ gstin, stateCode }).where(eq(payers.id, payerId))
    const set = { ...values, updatedAt: new Date(), updatedByName: session.name }
    await tx.insert(payerProfiles).values({ payerId, ...set }).onConflictDoUpdate({ target: payerProfiles.payerId, set })
    await logAudit(session, 'rcm: updated payer profile', null, `payer=${payerId} fields=${changed.sort().join(',')}`, tx)
    return rcmOk(null)
  })
}

export async function setPayerContacts(payerId: number, contacts: PayerContactsInput['contacts'], session: Session): Promise<RcmWriteResult<null>> {
  return getDb().transaction(async (tx) => {
    const [payer] = await tx.select({ id: payers.id }).from(payers).where(eq(payers.id, payerId)).for('update')
    if (!payer) return rcmFail('payer_not_found')
    await tx.delete(payerContacts).where(eq(payerContacts.payerId, payerId))
    if (contacts.length > 0) {
      await tx.insert(payerContacts).values(contacts.map((c) => ({
        payerId, name: c.name, designation: c.designation ?? null, phone: c.phone ?? null, email: c.email ?? null, isEscalation: c.isEscalation,
      })))
    }
    await logAudit(session, 'rcm: updated payer contacts', null, `payer=${payerId} contacts=${contacts.length}`, tx)
    return rcmOk(null)
  })
}

async function profileKinds(executor: WriteExecutor, ids: number[]): Promise<Map<number, PayerKind>> {
  if (ids.length === 0) return new Map()
  const rows = await executor.select({ id: payerProfiles.payerId, kind: payerProfiles.kind }).from(payerProfiles).where(inArray(payerProfiles.payerId, ids))
  return new Map(rows.map((r) => [r.id, r.kind]))
}

/** Replaces the TPAs that service an insurer. The insurer side must not be a TPA; each TPA must be one. */
export async function setPayerNetworks(insurerPayerId: number, tpaPayerIds: number[], session: Session): Promise<RcmWriteResult<null>> {
  return getDb().transaction(async (tx) => {
    const [payer] = await tx.select({ id: payers.id }).from(payers).where(eq(payers.id, insurerPayerId)).for('update')
    if (!payer) return rcmFail('payer_not_found')
    const kinds = await profileKinds(tx, [insurerPayerId, ...tpaPayerIds])
    const insurerKind = kinds.get(insurerPayerId)
    if (!insurerKind || !INSURER_SIDE_KINDS.includes(insurerKind)) return rcmFail('payer_kind_invalid')
    if (tpaPayerIds.some((id) => kinds.get(id) !== 'tpa')) return rcmFail('payer_kind_invalid')
    await tx.delete(payerNetworks).where(eq(payerNetworks.insurerPayerId, insurerPayerId))
    if (tpaPayerIds.length > 0) {
      await tx.insert(payerNetworks).values(tpaPayerIds.map((tpaPayerId) => ({ insurerPayerId, tpaPayerId, createdByName: session.name })))
    }
    await logAudit(session, 'rcm: updated payer network', null, `payer=${insurerPayerId} tpas=${tpaPayerIds.length}`, tx)
    return rcmOk(null)
  })
}

/** Replaces one claim type's document overrides for a payer; other claim types are untouched. */
export async function setDocumentRequirements(
  payerId: number, claimType: ClaimType, entries: DocumentRequirementsInput['entries'], session: Session,
): Promise<RcmWriteResult<null>> {
  return getDb().transaction(async (tx) => {
    const [payer] = await tx.select({ id: payers.id }).from(payers).where(eq(payers.id, payerId)).for('update')
    if (!payer) return rcmFail('payer_not_found')
    await tx.delete(payerDocumentRequirements).where(and(eq(payerDocumentRequirements.payerId, payerId), eq(payerDocumentRequirements.claimType, claimType)))
    if (entries.length > 0) {
      await tx.insert(payerDocumentRequirements).values(entries.map((e) => ({ payerId, claimType, documentKind: e.documentKind, required: e.required, updatedByName: session.name })))
    }
    await logAudit(session, 'rcm: updated document requirements', null, `payer=${payerId} claim_type=${claimType} entries=${entries.length}`, tx)
    return rcmOk(null)
  })
}

export async function listReasonCodes(category?: ReasonCategory): Promise<RcmReasonCodeRow[]> {
  const where = category ? and(eq(rcmReasonCodes.active, true), eq(rcmReasonCodes.category, category)) : eq(rcmReasonCodes.active, true)
  return getDb().select().from(rcmReasonCodes).where(where).orderBy(asc(rcmReasonCodes.sortOrder), asc(rcmReasonCodes.code))
}

export async function getHospitalIdentifiers(executor: WriteExecutor = getDb()): Promise<{ rohiniId: string | null; hfrId: string | null }> {
  const [row] = await executor.select({ rohiniId: billingSettings.rohiniId, hfrId: billingSettings.hfrId }).from(billingSettings).where(eq(billingSettings.id, 1)).limit(1)
  return row ?? { rohiniId: null, hfrId: null }
}

export async function updateHospitalIdentifiers(input: RcmSettingsInput, session: Session): Promise<RcmWriteResult<null>> {
  return getDb().transaction(async (tx) => {
    const set = { rohiniId: input.rohiniId, hfrId: input.hfrId, updatedAt: new Date(), updatedByName: session.name }
    await tx.insert(billingSettings).values({ id: 1, ...set }).onConflictDoUpdate({ target: billingSettings.id, set })
    await logAudit(session, 'rcm: updated hospital identifiers', null, null, tx)
    return rcmOk(null)
  })
}
