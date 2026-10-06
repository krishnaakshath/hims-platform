import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listUnsignedNotesReport } from '@/lib/queries/reports'
import { UnsignedNotesReportTable } from '@/components/UnsignedNotesReportTable'

export default async function UnsignedNotesReportPage() {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:60 — the Reports section is rendered for admin/crc only.
  // Same list, same redirect target as workbook/page.tsx:12.
  if (!['admin', 'crc'].includes(session.role)) redirect('/')
  const rows = await listUnsignedNotesReport()
  await logAudit(session, 'viewed report: unsigned notes', null)

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Unsigned Notes</h1>
      <UnsignedNotesReportTable rows={rows} />
    </div>
  )
}
