import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { logAudit } from '@/lib/audit'
import { VITALS_ROLES } from '@/lib/role-policy'
import { checkEncounterWriter, parseEncounterId } from '@/lib/encounters/ownership'
import { bmiTenths, vitalsFlags, vitalsInputSchema } from '@/lib/encounters/vitals'
import { EncounterClosedError, addVitals } from '@/lib/queries/encounter-clinical'
import { pgErrorCode } from '@/lib/db-errors'

// WS1 T2: record one vitals set. The crc may record on any open visit (nurse-style intake);
// a pi only on their own; admin on any. Audit carries the encounter id only, never a value.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!VITALS_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const encounterId = parseEncounterId(id)
  if (encounterId === null) return NextResponse.json({ error: 'Invalid encounter id' }, { status: 400 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = vitalsInputSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid vitals' }, { status: 400 })

  const check = await checkEncounterWriter(session, encounterId, { allowCrc: true })
  if (!check.ok) return NextResponse.json(check.body, { status: check.status })

  try {
    const row = await addVitals(check.encounter, parsed.data, session)
    await logAudit(session, 'recorded vitals', check.encounter.patientId, `encounter=${encounterId}`)
    return NextResponse.json({ vitals: { ...row, bmiTenths: bmiTenths(row.weightG, row.heightMm), flags: vitalsFlags(row) } }, { status: 201 })
  } catch (err) {
    if (err instanceof EncounterClosedError) return NextResponse.json({ error: 'Visit is closed', code: 'visit_closed' }, { status: 409 })
    console.error(`[encounters] vitals failed (code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not record vitals' }, { status: 500 })
  }
}
