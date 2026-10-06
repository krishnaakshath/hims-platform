import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listFaxes } from '@/lib/queries/faxes'
import { FaxHistoryReportTable } from '@/components/FaxHistoryReportTable'

export default async function FaxHistoryPage() {
  const session = await requireSessionOrRedirect()
  // Fax History is admin/crc only (the Documents page itself also admits pi/frontdesk).
  // Same list, same redirect target as workbook/page.tsx:12.
  if (!['admin', 'crc'].includes(session.role)) redirect('/')
  const faxes = await listFaxes()
  await logAudit(session, 'viewed fax history', null)

  return <FaxHistoryReportTable rows={faxes} />
}
