import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listAllEncountersReport } from '@/lib/queries/reports'
import { AllEncountersReportTable } from '@/components/AllEncountersReportTable'

export default async function AllEncountersReportPage() {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:60 — the Reports section is rendered for admin/crc only.
  // Same list, same redirect target as workbook/page.tsx:12.
  if (!['admin', 'crc'].includes(session.role)) redirect('/')
  const rows = await listAllEncountersReport()
  await logAudit(session, 'viewed report: all encounters', null)

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-foreground">All Encounters</h1>
      {/* Wave F P1-04: this legacy report lists completed appointments; hospital visits live in the OPD register. */}
      <p className="mb-6 text-sm text-muted-foreground">
        Completed appointments only. For every OPD/IPD visit by token, department, doctor and status, use the{' '}
        <Link href="/encounters" className="font-medium text-primary hover:underline">OPD Register</Link>.
      </p>
      <AllEncountersReportTable rows={rows} />
    </div>
  )
}
