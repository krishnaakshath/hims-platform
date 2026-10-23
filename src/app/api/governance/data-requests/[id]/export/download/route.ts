import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { streamPrivateBlob } from '@/lib/blob-store'
import { invalidIdResponse, parseId } from '@/lib/http'
import { serviceErrorResponse } from '@/lib/service-config'
import { getDataPrincipalExport } from '@/lib/queries/data-principal-requests'

// WS8 T14 (spec D18): download the prepared export bundle as an attachment. Admin only; audited
// after the bytes are found.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = parseId((await params).id)
  if (id === null) return invalidIdResponse()
  try {
    const found = await getDataPrincipalExport(id)
    if (!found) return NextResponse.json({ error: 'No export has been prepared for this request.' }, { status: 404 })
    const response = await streamPrivateBlob(found.url, { filename: `${found.reference}-export.json`, disposition: 'attachment' })
    if (!response) return NextResponse.json({ error: 'The stored export is missing. Prepare it again.' }, { status: 404 })
    await logAudit(session, 'downloaded data-principal export', found.patientId, `request=${id}`)
    return response
  } catch (err) {
    const service = serviceErrorResponse(err, 'data-principal export download')
    if (service) return service
    throw err
  }
}
