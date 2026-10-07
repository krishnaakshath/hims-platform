// /api/coding/services/[serviceId]/procedure-codes (SP6 Task 14): the service <-> procedure-code map.
// GET (CODE_LOOKUP_ROLES; no PHI): `{ codes }`, empty when the service is unmapped (= unconstrained
// for SP4 charge capture). PUT (CODING_ROLES): replace the whole map, body `serviceCodesSchema`;
// the query validates category fit and current-version codes and audits inside its transaction.
// The role gate runs inline right after requireSession, before the path id or body is read.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CODE_LOOKUP_ROLES, CODING_ROLES } from '@/lib/role-policy'
import { readJsonBody } from '@/lib/follow-ups/route-responses'
import { invalid, parseId } from '@/lib/tariff/route-responses'
import { codingJson as json, codingServerError } from '@/lib/coding/route-responses'
import { serviceCodesSchema } from '@/lib/coding/validation'
import { listServiceProcedureCodes, replaceServiceProcedureCodes } from '@/lib/queries/service-procedure-codes'

type Ctx = { params: Promise<{ serviceId: string }> }

const REFUSAL = {
  service_not_found: { status: 404, error: 'Service not found' },
  incompatible: { status: 400, error: 'These codes do not fit this service' },
  code_not_found: { status: 400, error: 'Some codes are not in the current code set' },
} as const

export async function GET(_request: NextRequest, { params }: Ctx) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODE_LOOKUP_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const serviceId = parseId((await params).serviceId)
  if (serviceId === null) return json(400, 'Invalid service id')
  try {
    const map = await listServiceProcedureCodes([serviceId])
    return NextResponse.json({ codes: map.get(serviceId) ?? [] })
  } catch (err) {
    return codingServerError('list service procedure codes', err, 'Could not load the procedure codes')
  }
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const read = await readJsonBody(request)
  if (!read.ok) return read.response
  const serviceId = parseId((await params).serviceId)
  if (serviceId === null) return json(400, 'Invalid service id')
  const parsed = serviceCodesSchema.safeParse(read.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid service code mapping')

  try {
    const r = await replaceServiceProcedureCodes(serviceId, parsed.data.codes, session)
    if (r.ok) return NextResponse.json({ ok: true })
    const { status, error } = REFUSAL[r.error]
    return NextResponse.json(r.problems ? { error, problems: r.problems } : { error }, { status })
  } catch (err) {
    return codingServerError('replace service procedure codes', err, 'Could not save the procedure codes')
  }
}
