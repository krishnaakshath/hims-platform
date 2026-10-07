import { notFound, redirect } from 'next/navigation'
import { demoFeaturesEnabled } from '@/lib/demo-features'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listFaxes } from '@/lib/queries/faxes'
import { FaxHistoryReportTable } from '@/components/FaxHistoryReportTable'

export default async function FaxHistoryPage() {
  const session = await requireSessionOrRedirect()
  // Fax History is admin/crc only (the Documents page itself also admits pi/frontdesk).
  // Same list, same redirect target as workbook/page.tsx:12.
  if (!['admin', 'crc'].includes(session.role)) redirect('/')
  // Wave B P1-21: demo-only page -- 404 unless DEMO_FEATURES is on (after the role gate, before any read).
  if (!demoFeaturesEnabled()) notFound()
  const faxes = await listFaxes()
  await logAudit(session, 'viewed fax history', null)

  return <FaxHistoryReportTable rows={faxes} />
}
