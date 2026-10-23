import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { readJsonBody } from '@/lib/http'
import { requireSession } from '@/lib/auth'
import { DISPENSE_ROLES } from '@/lib/role-policy'
import { getDb } from '@/db/client'
import { medicationInventory } from '@/db/schema'
import { formatPaise } from '@/lib/format'
import { dispenseMedication, dispenseSchema, type DispenseError } from '@/lib/queries/medication-dispenses'

// WS2 T8 (spec ruling 7): dispensing bills itself; the audit row is written on the dispense transaction.
const ERRORS: Record<DispenseError, { status: number; message: string }> = {
  unknown_patient: { status: 400, message: 'Unknown patient' },
  unknown_medication: { status: 400, message: 'Unknown medication' },
  episode_mismatch: { status: 400, message: 'medicationEpisodeId does not belong to this patient' },
  not_enough_stock: { status: 409, message: 'Not enough stock on hand for this quantity' },
  medication_unpriced: { status: 422, message: 'This medicine has no price (MRP) set. Set its MRP on the Pharmacy page, or dispense it free of charge with a reason.' },
  batch_required: { status: 422, message: 'Enter the batch number and expiry month from the strip' },
  batch_expired: { status: 422, message: 'This batch has expired. Do not dispense it.' },
  allergy_conflict: { status: 409, message: 'This medicine conflicts with an allergy on record. Check with the prescriber, then confirm to dispense.' },
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!DISPENSE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = dispenseSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid dispense payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await dispenseMedication(parsed.data, session)
  if (!result.ok) {
    const e = ERRORS[result.error]
    return NextResponse.json({ error: e.message, code: result.error, ...(result.conflicts ? { conflicts: result.conflicts } : {}) }, { status: e.status })
  }

  const [inv] = await getDb().select({ unit: medicationInventory.unit }).from(medicationInventory).where(eq(medicationInventory.medicationId, parsed.data.medicationId))
  const dispensed = `Dispensed ${parsed.data.quantity} ${inv?.unit ?? 'units'}`
  const message = result.charge ? `${dispensed}. ${formatPaise(result.charge.totalPaise)} added to the bill.` : `${dispensed} at no charge.`
  return NextResponse.json({ id: result.dispenseId, charge: result.charge, message }, { status: 201 })
}
