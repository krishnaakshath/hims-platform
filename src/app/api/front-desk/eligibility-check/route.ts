import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { simulateEligibilityCheck, recordEligibilityCheck } from '@/lib/queries/insurance-eligibility'
import { getPayerById } from '@/lib/queries/payers'

const eligibilitySchema = z.object({
  patientId: z.string().min(1),
  payerId: z.number().int(),
}).strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // Insurance verification moved fully to billing -- front desk previously
  // ran eligibility checks at check-in, removed per explicit product
  // direction: billing now owns insurance end-to-end.
  if (!['billing', 'admin', 'crc'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const parsed = eligibilitySchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid eligibility-check payload', details: parsed.error.flatten() }, { status: 400 })

  const { patientId, payerId } = parsed.data
  const payer = await getPayerById(payerId)
  if (!payer) return NextResponse.json({ error: 'Unknown payer' }, { status: 400 })

  // No patient row is otherwise fetched on this path, so planType is
  // resolved as null here rather than adding a lookup solely for this field.
  const { status, copayCents, deductibleRemainingCents, planType, coverageStartDate } = simulateEligibilityCheck(patientId, payer.name, null)
  const created = await recordEligibilityCheck({ patientId, payerName: payer.name, payerId: payer.id, status, copayCents, deductibleRemainingCents, planType, coverageStartDate, checkedByName: session.name })

  await logAudit(session, `verified insurance eligibility (${status})`, patientId)
  return NextResponse.json(created, { status: 201 })
}
