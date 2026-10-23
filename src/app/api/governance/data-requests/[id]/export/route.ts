import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { invalidIdResponse, parseId } from '@/lib/http'
import { serviceErrorResponse } from '@/lib/service-config'
import { prepareDataPrincipalExport } from '@/lib/queries/data-principal-requests'

// WS8 T14 (spec D18): build the export bundle (FHIR Bundle + manifest) and store it privately.
// Admin only. Answers { ok: true }; the storage location is never returned.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = parseId((await params).id)
  if (id === null) return invalidIdResponse()
  try {
    const result = await prepareDataPrincipalExport(id, session)
    if (!result.ok) {
      return result.error === 'not_found'
        ? NextResponse.json({ error: 'Request not found' }, { status: 404 })
        : NextResponse.json({ error: 'This request no longer has a patient chart to export.', code: result.error }, { status: 409 })
    }
  } catch (err) {
    const service = serviceErrorResponse(err, 'data-principal export')
    if (service) return service
    throw err
  }
  return NextResponse.json({ ok: true })
}
