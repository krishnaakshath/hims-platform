import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { readJsonBody } from '@/lib/http'
import { DATA_PRINCIPAL_REQUEST_KINDS, DATA_PRINCIPAL_REQUEST_VIA } from '@/db/schema'
import { createDataPrincipalRequest, listDataPrincipalRequests } from '@/lib/queries/data-principal-requests'

// WS8 T14 (spec D18): the DPDP data-principal request register -- admin only. The list never
// carries an export URL; the audit details carry the request id and kind, never the note.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v))

const createSchema = z.object({
  patientRef: z.string().trim().min(1).max(64),
  kind: z.enum(DATA_PRINCIPAL_REQUEST_KINDS),
  receivedVia: z.enum(DATA_PRINCIPAL_REQUEST_VIA),
  receivedAt: isoDate,
  note: z.string().max(500).optional(),
}).strict()

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const requests = await listDataPrincipalRequests()
  await logAudit(session, 'viewed data-principal requests', null, `count=${requests.length}`)
  return NextResponse.json({ requests })
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = createSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Enter the patient UHID, the request type, how it was received and the date received (YYYY-MM-DD).', code: 'invalid' }, { status: 400 })

  const result = await createDataPrincipalRequest(parsed.data, session)
  if (!result.ok) return NextResponse.json({ error: 'No patient has that UHID.', code: result.error }, { status: 404 })
  return NextResponse.json({ id: result.id, reference: result.reference, dueBy: result.dueBy }, { status: 201 })
}
