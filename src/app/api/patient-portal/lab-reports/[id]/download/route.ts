// SP5: the signed-in patient's own lab report PDF. A report that is not theirs, or has been
// superseded, is a 404 (never a 403, which would confirm it exists). Audited after the stored
// file was found.
import { NextRequest, NextResponse } from 'next/server'
import { requirePatientSession } from '@/lib/patient-session'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { streamPrivateBlob } from '@/lib/blob-store'
import { getLabReportForDownload } from '@/lib/queries/lab-reports'
import { parseId } from '@/lib/http'
import { withServiceGuard } from '@/lib/service-config'

const notFound = () => NextResponse.json({ error: 'Report not found' }, { status: 404 })

export const GET = withServiceGuard('patient lab report download', async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requirePatientSession()
  if (session instanceof NextResponse) return session

  const reportId = parseId((await params).id)
  if (reportId === null) return notFound()
  const report = await getLabReportForDownload(reportId)
  if (!report || report.patientId !== session.patientId || report.supersededAt !== null) return notFound()

  const res = await streamPrivateBlob(report.blobUrl, { filename: `${report.reportNumber}.pdf`, disposition: 'attachment' })
  if (!res) return notFound()
  await logPatientPortalAction('downloaded lab report via patient portal', session.patientId, `report=${report.id}`)
  return res
})
