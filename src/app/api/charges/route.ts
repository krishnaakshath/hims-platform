import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { CHARGES_ROLES } from '@/lib/role-policy'
import { listCharges, createCharge } from '@/lib/queries/charges'

const createChargeSchema = z.object({
  patientId: z.string().min(1),
  providerName: z.string().min(1),
  dateOfService: z.string().min(1),
  diagnosisCodes: z.array(z.object({ code: z.string().min(1), description: z.string().min(1) })).min(1),
  procedureCodes: z.array(z.object({
    code: z.string().min(1), description: z.string().min(1), units: z.number().int().positive(), chargeCents: z.number().int().positive(),
  })).min(1),
  notes: z.string().optional(),
}).strict()

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CHARGES_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  await logAudit(session, 'viewed charges list', null)
  return NextResponse.json(await listCharges())
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  // Creating a charge is billing/registration staff's authority. This gate
  // was missing entirely until the `pharmacy` role was added: without it,
  // pharmacy would have been able to create an arbitrary charge for any
  // patient with any code and amount, outside the one narrow, server-derived
  // dispense-billing path it is actually given (POST
  // /api/pharmacy/dispenses/[dispenseId]/charge). Same tier as /billing's own
  // nav visibility (LeftNav.tsx:98). This also, correctly, closes the route
  // to `pi`, which had incidental access via the missing gate.
  if (!CHARGES_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = createChargeSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid charge payload', details: parsed.error.flatten() }, { status: 400 })

  // amountCents is never trusted from the client -- it's derived here from
  // procedureCodes so a charge's stored total can never drift from its own
  // line items, whether by a client bug or a direct API call.
  const amountCents = parsed.data.procedureCodes.reduce((sum, p) => sum + p.units * p.chargeCents, 0)

  const created = await createCharge({ ...parsed.data, amountCents })
  await logAudit(session, 'created charge', parsed.data.patientId)
  return NextResponse.json(created, { status: 201 })
}
