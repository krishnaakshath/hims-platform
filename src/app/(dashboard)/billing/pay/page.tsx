import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { listCharges } from '@/lib/queries/charges'
import { VirtualCardPaymentForm } from '@/components/VirtualCardPaymentForm'

export default async function VirtualCardPaymentPage({
  searchParams,
}: {
  searchParams: Promise<{ patientId?: string; amountCents?: string }>
}) {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:98 — the Billing group is rendered for admin/crc/frontdesk only.
  if (!['admin', 'crc', 'billing'].includes(session.role)) redirect('/')
  const { patientId, amountCents } = await searchParams
  const [patients, charges] = await Promise.all([listPatientsWithStatus(null), listCharges()])
  await logAudit(session, 'viewed virtual card payment form (demo)', patientId ?? null)

  // A payment recorded through this form always has chargeId: null --
  // computeChargeBalances() (billing-calculations.ts) can only pool it
  // against a patient's SUBMITTED charges, so a patient with none would
  // have their payment counted by nothing, anywhere. Restricting the
  // dropdown to billable patients keeps every payment this form can create
  // attributable.
  const billablePatientIds = new Set(charges.filter((c) => c.status === 'submitted').map((c) => c.patientId))
  const billablePatients = patients.filter((p) => billablePatientIds.has(p.id))

  return (
    <div className="max-w-xl">
      <h1 className="mb-6 text-2xl font-bold text-foreground">Virtual Card Payment</h1>
      <VirtualCardPaymentForm
        patients={billablePatients.map((p) => ({ id: p.id, name: p.name }))}
        initialPatientId={patientId}
        initialAmountCents={amountCents ? Number(amountCents) : undefined}
      />
    </div>
  )
}
