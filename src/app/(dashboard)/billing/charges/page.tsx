import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listCharges } from '@/lib/queries/charges'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { listPharmacyChargeIds } from '@/lib/queries/medication-dispenses'
import { CHARGE_STATUS_LABELS, type ChargeStatus } from '@/lib/charge-status'
import { ChargesTable } from '@/components/ChargesTable'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

// Wave E P1-19: ?status= opens the table on that status (the user can still
// clear it); ?source=pharmacy lists only bills raised from a medication
// dispense. Unknown values are ignored. Both come from the billing home tiles.
export default async function ChargesPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:98 — the Billing group is rendered for admin/crc/frontdesk only.
  if (!['admin', 'crc', 'billing'].includes(session.role)) redirect('/')

  const sp = (await searchParams) ?? {}
  const rawStatus = one(sp.status)
  const status = rawStatus && rawStatus in CHARGE_STATUS_LABELS ? (rawStatus as ChargeStatus) : undefined
  const pharmacyOnly = one(sp.source) === 'pharmacy'

  const [all, patients, pharmacyIds] = await Promise.all([
    listCharges(),
    listPatientsWithStatus(null),
    pharmacyOnly ? listPharmacyChargeIds() : Promise.resolve([] as number[]),
  ])
  const pharmacy = new Set(pharmacyIds)
  const charges = pharmacyOnly ? all.filter((c) => pharmacy.has(c.id)) : all
  await logAudit(session, 'viewed charges', null)

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-foreground">{pharmacyOnly ? 'Pharmacy charges' : 'Charges'}</h1>
      {pharmacyOnly && (
        <p className="mb-4 text-sm text-muted-foreground">
          Bills raised from dispensed medications only. <Link href="/billing/charges" className="font-medium text-primary hover:underline">Show every charge</Link>
        </p>
      )}
      <div className={pharmacyOnly ? '' : 'mt-4'}>
        <ChargesTable
          charges={charges}
          patients={patients.map((p) => ({ id: p.id, name: p.name }))}
          initialStatus={status}
        />
      </div>
    </div>
  )
}
