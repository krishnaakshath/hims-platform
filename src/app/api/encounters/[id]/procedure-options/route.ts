import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { pgErrorCode } from '@/lib/db-errors'
import { checkEncounterWriter, parseEncounterId } from '@/lib/encounters/ownership'
import { listProcedureOptions } from '@/lib/queries/procedure-orders'
import { CLINICAL_WRITE_ROLES } from '@/lib/role-policy'

const querySchema = z.object({ q: z.string().max(100).optional() }).strict()

// WS2 T11: the procedure picker: active procedure services (at most 20) priced for this visit.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const encounterId = parseEncounterId((await params).id)
  if (encounterId === null) return NextResponse.json({ error: 'Invalid visit id' }, { status: 400 })
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid search' }, { status: 400 })

  try {
    const check = await checkEncounterWriter(session, encounterId)
    if (!check.ok) return NextResponse.json(check.body, { status: check.status })
    const options = await listProcedureOptions(encounterId, parsed.data.q ?? '')
    await logAudit(session, 'viewed procedure options', check.encounter.patientId, `encounter=${encounterId}`)
    return NextResponse.json({ options })
  } catch (err) {
    console.error(`[procedures] options failed (code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not load the procedures' }, { status: 500 })
  }
}
