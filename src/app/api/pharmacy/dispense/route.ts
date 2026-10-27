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
  // WS5 T5: stock refusals from the batch allocator.
  insufficient_stock: { status: 409, message: 'Not enough stock on hand for this quantity' },
  only_expired_stock: { status: 409, message: 'Only expired stock is left for this quantity; write it off and receive fresh stock' },
  batch_mismatch: { status: 400, message: 'That batch is not stock of this medication' },
  opening_batch_written_off: { status: 409, message: 'The OPENING batch of this medication is written off; receive stock before dispensing' },
  medication_unpriced: { status: 422, message: 'This medicine has no price (MRP) set. Set its MRP on the Pharmacy page, or dispense it free of charge with a reason.' },
  batch_required: { status: 422, message: 'Enter the batch number and expiry month from the strip' },
  batch_expired: { status: 422, message: 'This batch has expired. Do not dispense it.' },
  allergy_conflict: { status: 409, message: 'This medicine conflicts with an allergy on record. Check with the prescriber, then confirm to dispense.' },
}
// WS5 T5: a picked batch that has expired is a stock refusal (409); a typed strip expiry stays 422.
const PICKED_BATCH_EXPIRED = { status: 409, message: 'This batch has expired and cannot be dispensed' }

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
    const e = result.error === 'batch_expired' && result.stockRefusal ? PICKED_BATCH_EXPIRED : ERRORS[result.error]
    return NextResponse.json({ error: e.message, code: result.error, ...(result.conflicts ? { conflicts: result.conflicts } : {}) }, { status: e.status })
  }

  const [inv] = await getDb().select({ unit: medicationInventory.unit }).from(medicationInventory).where(eq(medicationInventory.medicationId, parsed.data.medicationId))
  const dispensed = `Dispensed ${parsed.data.quantity} ${inv?.unit ?? 'units'}`
  const message = result.charge ? `${dispensed}. ${formatPaise(result.charge.totalPaise)} added to the bill.` : `${dispensed} at no charge.`
  // WS5 T5: ids/allocations name each batch the dispense drew from (one dispense row each).
  const allocations = result.allocations.map(({ dispenseId, batchId, batchNo, expiryMonth, quantity }) => ({ dispenseId, batchId, batchNo, expiryMonth, quantity }))
  return NextResponse.json({ id: result.dispenseId, ids: result.dispenseIds, allocations, charge: result.charge, charges: result.charges, message }, { status: 201 })
}
