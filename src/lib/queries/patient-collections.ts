import { getDb } from '@/db/client'
import { charges, insuranceClaims, mockPayments, patients } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { getOrSetCache, patientCollectionsListCacheKey } from '@/lib/cache'
import { computeChargeBalances } from '@/lib/billing-calculations'

export async function listPatientCollections() {
  return getOrSetCache(patientCollectionsListCacheKey(), 30, async () => {
    const db = getDb()
    const submittedCharges = await db.select().from(charges).where(eq(charges.status, 'submitted'))
    const claims = await db.select().from(insuranceClaims)
    const payments = await db.select().from(mockPayments)
    const allPatients = await db.select().from(patients)
    const balances = computeChargeBalances(submittedCharges, claims, payments)

    const byPatient = new Map<string, { balanceCents: number; unappliedCents: number }>()

    for (const charge of submittedCharges) {
      const { outstandingCents, unappliedPatientPaymentCents } = balances.get(charge.id)!

      const existing = byPatient.get(charge.patientId) ?? { balanceCents: 0, unappliedCents: 0 }
      byPatient.set(charge.patientId, {
        balanceCents: existing.balanceCents + outstandingCents,
        unappliedCents: existing.unappliedCents + unappliedPatientPaymentCents,
      })
    }

    return Array.from(byPatient.entries())
      .filter(([, v]) => v.balanceCents > 0 || v.unappliedCents > 0)
      .map(([patientId, v]) => {
        const patient = allPatients.find((p) => p.id === patientId)
        return {
          patientId,
          patientName: patient ? patient.name : patientId,
          balanceCents: v.balanceCents,
          unappliedCents: v.unappliedCents,
        }
      })
      .sort((a, b) => b.balanceCents - a.balanceCents)
  })
}
