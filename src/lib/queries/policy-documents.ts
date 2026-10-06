import { getDb } from '@/db/client'
import { policyDocuments, signatures } from '@/db/schema'
import { and, desc, eq, inArray } from 'drizzle-orm'

export type PolicyDocumentType = 'npp' | 'tos'
export type PolicyDocument = typeof policyDocuments.$inferSelect

/** The current (highest-version) row for a policy type, or null if none exist yet. */
export async function getLatestPolicyDocument(type: PolicyDocumentType): Promise<PolicyDocument | null> {
  const rows = await getDb()
    .select()
    .from(policyDocuments)
    .where(eq(policyDocuments.type, type))
    .orderBy(desc(policyDocuments.version))
    .limit(1)
  return rows[0] ?? null
}

/**
 * True only if the patient has a signature on file for BOTH current policy
 * versions. A patient who accepted an older version (before a policy was
 * updated) must re-accept -- this deliberately does not "carry forward" an
 * old acceptance across a version bump.
 */
export async function hasAcceptedCurrentPolicies(patientId: string): Promise<boolean> {
  const [npp, tos] = await Promise.all([getLatestPolicyDocument('npp'), getLatestPolicyDocument('tos')])
  if (!npp || !tos) return false // no policy seeded yet -- fail closed, don't silently skip the gate

  const rows = await getDb()
    .select({ signableId: signatures.signableId })
    .from(signatures)
    .where(and(
      eq(signatures.signableType, 'policy_acceptance'),
      eq(signatures.patientId, patientId),
      inArray(signatures.signableId, [npp.id, tos.id]),
    ))

  const signedIds = new Set(rows.map((r) => r.signableId))
  return signedIds.has(npp.id) && signedIds.has(tos.id)
}

/** Records the patient's acceptance of both current policy documents as two signature rows. */
export async function recordPolicyAcceptance(patientId: string, signerTypedName: string): Promise<void> {
  const [npp, tos] = await Promise.all([getLatestPolicyDocument('npp'), getLatestPolicyDocument('tos')])
  if (!npp || !tos) throw new Error('No current policy documents to accept')

  await getDb().insert(signatures).values([
    {
      signableType: 'policy_acceptance',
      signableId: npp.id,
      patientId,
      signerTypedName,
      signerRole: 'patient',
      attestationText: `I acknowledge that I have received and reviewed the Notice of Privacy Practices, version ${npp.version}.`,
    },
    {
      signableType: 'policy_acceptance',
      signableId: tos.id,
      patientId,
      signerTypedName,
      signerRole: 'patient',
      attestationText: `I have read and agree to the Terms of Service, version ${tos.version}.`,
    },
  ])
}
