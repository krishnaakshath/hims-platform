import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { invalidIdResponse, parseId, readJsonBody } from '@/lib/http'
import { RETRY_MESSAGE, isRetryableConflict } from '@/lib/db-errors'
import { DATA_PRINCIPAL_CHECKLIST_KEYS, DATA_PRINCIPAL_REQUEST_STATUSES } from '@/db/schema'
import { getDataPrincipalRequest, updateDataPrincipalRequest } from '@/lib/queries/data-principal-requests'

// WS8 T14 (spec D18): one register entry (GET) and its status, checklist and decision note (PATCH).
// Admin only. The response says whether an export exists, never where it is stored.
const checklistSchema = z.object(Object.fromEntries(DATA_PRINCIPAL_CHECKLIST_KEYS.map((k) => [k, z.boolean().optional()])) as Record<(typeof DATA_PRINCIPAL_CHECKLIST_KEYS)[number], z.ZodOptional<z.ZodBoolean>>).strict()

const patchSchema = z.object({
  status: z.enum(DATA_PRINCIPAL_REQUEST_STATUSES).optional(),
  checklist: checklistSchema.optional(),
  decisionNote: z.string().max(1000).optional(),
}).strict().refine((b) => b.status !== undefined || b.checklist !== undefined || b.decisionNote !== undefined)

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = parseId((await params).id)
  if (id === null) return invalidIdResponse()
  const found = await getDataPrincipalRequest(id)
  if (!found) return NextResponse.json({ error: 'Request not found' }, { status: 404 })
  await logAudit(session, 'viewed data-principal request', found.patientId, `request=${id}`)
  return NextResponse.json(found)
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = parseId((await params).id)
  if (id === null) return invalidIdResponse()
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = patchSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Nothing to change, or a field was not valid.', code: 'invalid' }, { status: 400 })

  try {
    const result = await updateDataPrincipalRequest(id, parsed.data, session)
    if (!result.ok) return NextResponse.json({ error: 'Request not found' }, { status: 404 })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    throw err
  }
  return NextResponse.json({ ok: true })
}
