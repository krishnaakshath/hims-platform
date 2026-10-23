import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listMedicationsWithInventory, listActiveMedicationEpisodeSummary } from '@/lib/queries/medications'
import { PharmacyDashboard } from '@/components/dashboards/PharmacyDashboard'
import { getPharmacyKpis } from '@/lib/queries/hospital-kpis' // Wave E
import { loadNeedsAttention } from '@/lib/queries/needs-attention' // WS8 T15
import { todayIsoIn } from '@/lib/india-time' // WS8 T15

export default async function PharmacyPage({ searchParams }: { searchParams?: Promise<{ stock?: string | string[] }> } = {}) {
  const session = await requireSessionOrRedirect()
  // Matches LeftNav's roles for this route -- previously nav-hidden only,
  // with no actual server-side check.
  if (!['crc', 'pi', 'admin', 'pharmacy'].includes(session.role)) redirect('/')
  const stock = (await searchParams)?.stock
  const stockFilter = stock === 'out' || stock === 'low' ? stock : null
  const [medications, prescribedSummary, kpis, attention] = await Promise.all([
    listMedicationsWithInventory(), listActiveMedicationEpisodeSummary(), getPharmacyKpis(),
    // WS8 T15: the strip belongs to the pharmacy role's home; other roles reach /pharmacy from their own homes.
    session.role === 'pharmacy' ? loadNeedsAttention(session.role, todayIsoIn()) : Promise.resolve([]),
  ])
  await logAudit(session, 'viewed pharmacy dashboard', null)

  return (
    <PharmacyDashboard
      session={session}
      medications={medications}
      canDispense={['admin', 'pi', 'pharmacy'].includes(session.role)}
      prescribedSummary={prescribedSummary}
      canAddMedication={['admin', 'pharmacy'].includes(session.role)}
      kpis={kpis}
      stockFilter={stockFilter}
      // The counter pages (/pharmacy/patient-lookup, /pharmacy/billing) admit pharmacy and admin only.
      canUseCounter={['admin', 'pharmacy'].includes(session.role)}
      attention={attention} // WS8 T15
    />
  )
}
