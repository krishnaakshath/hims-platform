// SP5: staff download of a released lab report PDF (any version: the chart lists superseded
// ones too). The blob is private; this route streams it and audits only after it was found.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { streamPrivateBlob } from '@/lib/blob-store'
import { LAB_REPORT_READ_ROLES } from '@/lib/role-policy'
import { getLabReportForDownload } from '@/lib/queries/lab-reports'
import { errorResponse, parseId } from '@/lib/labs/route-responses'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_REPORT_READ_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const reportId = parseId((await params).id)
  if (reportId === null) return errorResponse(404, 'Report not found')
  const report = await getLabReportForDownload(reportId)
  if (!report) return errorResponse(404, 'Report not found')

  const res = await streamPrivateBlob(report.blobUrl, { filename: `${report.reportNumber}.pdf`, disposition: 'inline' })
  if (!res) return errorResponse(404, 'Stored file is missing')
  await logAudit(session, 'downloaded lab report', report.patientId, `report=${report.id}`)
  return res
}
