import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listMedicationsWithInventory, listActiveMedicationEpisodeSummary } from '@/lib/queries/medications'
import { PharmacyDashboard } from '@/components/dashboards/PharmacyDashboard'
import { getPharmacyKpis } from '@/lib/queries/hospital-kpis' // Wave E
import { todayIsoIn } from '@/lib/india-time' // WS5 T4
import type { StockFilter } from '@/components/dashboards/PharmacyDashboard' // WS5 T4

const STOCK_FILTERS: readonly StockFilter[] = ['out', 'low', 'expiring', 'expired'] // WS5 T4

export default async function PharmacyPage({ searchParams }: { searchParams?: Promise<{ stock?: string | string[] }> } = {}) {
  const session = await requireSessionOrRedirect()
  // Matches LeftNav's roles for this route -- previously nav-hidden only,
  // with no actual server-side check.
  if (!['crc', 'pi', 'admin', 'pharmacy'].includes(session.role)) redirect('/')
  const stock = (await searchParams)?.stock
  const stockFilter = STOCK_FILTERS.find((f) => f === stock) ?? null
  const today = todayIsoIn() // WS5 T4: one IST date for the expiry fields, the KPIs and the "Expires in" labels
  const [medications, prescribedSummary, kpis] = await Promise.all([listMedicationsWithInventory(today), listActiveMedicationEpisodeSummary(), getPharmacyKpis(today)])
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
      today={today}
    />
  )
}
