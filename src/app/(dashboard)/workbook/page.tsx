import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CLINICAL_ROLES, WORKBOOK_EXPORT_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { listWorkbookRows } from '@/lib/queries/workbook'
import { WorkbookTable } from '@/components/WorkbookTable'

export default async function WorkbookPage() {
  const session = await requireSessionOrRedirect()
  // Same roles as the Workbook nav entry (admin, crc, pi); the nav only hides
  // the link, this is the enforcement.
  if (!CLINICAL_ROLES.includes(session.role)) redirect('/')
  // The full-workbook download is narrower (admin, crc): pi would get a 403.
  const canDownload = WORKBOOK_EXPORT_ROLES.includes(session.role)
  const rows = await listWorkbookRows()
  await logAudit(session, 'viewed full pre-screening workbook', null)

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Pre-Screening Workbook</h1>
          <p className="mt-1 text-sm text-muted-foreground">All 30 tracked fields, one row per patient.</p>
        </div>
        {canDownload && (
          <a
            href="/api/workbook/full"
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground shadow-none transition-opacity hover:opacity-90"
          >
            Download Full Workbook
          </a>
        )}
      </div>
      <WorkbookTable rows={rows} isAdmin={session.role === 'admin'} />
    </div>
  )
}
