// WS1 T4: referrals written from the consultation workspace, and the referred-to doctor's
// "Referred to me" list. Callers (routes) have already run the role gate and checkEncounterWriter;
// the write re-reads the visit's status under a share lock (a completion waits for it).
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import { departments, encounters, patients, providers, referrals, type EncounterRow, type ReferralRow } from '@/db/schema'
import type { Session } from '@/lib/auth'
import type { ReferralInput } from '@/lib/encounters/diagnosis-validation'
import { EncounterClosedError } from './encounter-clinical'

/** The named department or doctor does not exist (or the doctor is inactive). */
export class ReferralTargetError extends Error {
  constructor() { super('Unknown referral target'); this.name = 'ReferralTargetError' }
}

export async function createReferral(encounter: EncounterRow, input: ReferralInput, session: Session): Promise<ReferralRow> {
  return getDb().transaction(async (tx) => {
    const [enc] = await tx.select({ status: encounters.status }).from(encounters).where(eq(encounters.id, encounter.id)).for('share')
    if (!enc || enc.status === 'completed' || enc.status === 'cancelled') throw new EncounterClosedError()

    if (input.kind === 'internal') {
      if (input.toDepartmentId !== undefined) {
        const [d] = await tx.select({ id: departments.id }).from(departments).where(and(eq(departments.id, input.toDepartmentId), eq(departments.isActive, true)))
        if (!d) throw new ReferralTargetError()
      }
      if (input.toProviderId !== undefined) {
        const [p] = await tx.select({ id: providers.id }).from(providers).where(and(eq(providers.id, input.toProviderId), eq(providers.isActive, true)))
        if (!p) throw new ReferralTargetError()
      }
    }

    const [row] = await tx.insert(referrals).values({
      encounterId: encounter.id,
      patientId: encounter.patientId,
      kind: input.kind,
      toDepartmentId: input.kind === 'internal' ? input.toDepartmentId ?? null : null,
      toProviderId: input.kind === 'internal' ? input.toProviderId ?? null : null,
      externalFacility: input.kind === 'external' ? input.externalFacility : null,
      externalDoctor: input.kind === 'external' ? (input.externalDoctor || null) : null,
      reason: input.reason,
      urgency: input.urgency,
      createdByName: session.name,
      createdByUserId: session.userId ?? null,
    }).returning()
    return row
  })
}

const fromProvider = alias(providers, 'referring_provider')

/**
 * Open internal referrals addressed to this doctor, or to their department without a named
 * doctor. Most urgent first, then newest. Capped at 50.
 */
export async function listOpenReferralsToProvider(providerId: number, departmentId: number | null):
  Promise<{ id: number; patientId: string; patientName: string; uhid: string | null; fromProviderName: string; urgency: string; createdAt: Date }[]> {
  const target = departmentId === null
    ? eq(referrals.toProviderId, providerId)
    : or(eq(referrals.toProviderId, providerId), and(isNull(referrals.toProviderId), eq(referrals.toDepartmentId, departmentId)))
  return getDb().select({
    id: referrals.id, patientId: referrals.patientId, patientName: patients.name, uhid: patients.uhid,
    fromProviderName: fromProvider.name, urgency: referrals.urgency, createdAt: referrals.createdAt,
  }).from(referrals)
    .innerJoin(patients, eq(patients.id, referrals.patientId))
    .innerJoin(encounters, eq(encounters.id, referrals.encounterId))
    .innerJoin(fromProvider, eq(fromProvider.id, encounters.providerId))
    .where(and(eq(referrals.status, 'open'), eq(referrals.kind, 'internal'), target))
    .orderBy(sql`CASE ${referrals.urgency} WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END`, desc(referrals.createdAt), desc(referrals.id))
    .limit(50)
}

/** Referrals written from this visit, oldest first, with the target's display names. */
export async function listEncounterReferrals(encounterId: number):
  Promise<{ id: number; kind: 'internal' | 'external'; target: string; urgency: string; status: string; createdAt: Date }[]> {
  const toProvider = alias(providers, 'to_provider')
  const rows = await getDb().select({
    id: referrals.id, kind: referrals.kind, urgency: referrals.urgency, status: referrals.status, createdAt: referrals.createdAt,
    departmentName: departments.name, providerName: toProvider.name, externalFacility: referrals.externalFacility, externalDoctor: referrals.externalDoctor,
  }).from(referrals)
    .leftJoin(departments, eq(departments.id, referrals.toDepartmentId))
    .leftJoin(toProvider, eq(toProvider.id, referrals.toProviderId))
    .where(eq(referrals.encounterId, encounterId))
    .orderBy(referrals.id)
  return rows.map((r) => ({
    id: r.id, kind: r.kind, urgency: r.urgency, status: r.status, createdAt: r.createdAt,
    target: r.kind === 'external'
      ? [r.externalFacility, r.externalDoctor].filter(Boolean).join(' · ')
      : [r.providerName, r.departmentName].filter(Boolean).join(' · '),
  }))
}

/** The doctor's department (for department-addressed referrals), or null. */
export async function providerDepartmentId(providerId: number): Promise<number | null> {
  const [row] = await getDb().select({ departmentId: providers.departmentId }).from(providers).where(eq(providers.id, providerId))
  return row?.departmentId ?? null
}
