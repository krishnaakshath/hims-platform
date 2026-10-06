import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listCharges } from '@/lib/queries/charges'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { ChargesTable } from '@/components/ChargesTable'

export default async function ChargesPage() {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:98 — the Billing group is rendered for admin/crc/frontdesk only.
  if (!['admin', 'crc', 'billing'].includes(session.role)) redirect('/')
  const [charges, patients] = await Promise.all([listCharges(), listPatientsWithStatus(null)])
  await logAudit(session, 'viewed charges', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Charges</h1>
      <ChargesTable
        charges={charges}
        patients={patients.map((p) => ({ id: p.id, name: p.name }))}
      />
    </div>
  )
}
