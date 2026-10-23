import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { parseId, readJsonBody } from '@/lib/http'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { MEDICATION_PRICE_ROLES } from '@/lib/role-policy'
import { getDb } from '@/db/client'
import { medications } from '@/db/schema'
import { medicationPriceSchema } from '@/lib/billing/pharmacy-price'

// WS2 T8 (spec ruling 7): pharmacy sets a medicine's GST-inclusive MRP per dispensing unit and,
// optionally, its own GST slab and HSN (null = the billing settings defaults; omitted = unchanged).
// The audit row carries the id and the old/new amounts only, never the drug name.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!MEDICATION_PRICE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id: rawId } = await params
  const id = parseId(rawId)
  if (id === null) return NextResponse.json({ error: 'Invalid medication id' }, { status: 400 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = medicationPriceSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid price', details: parsed.error.flatten() }, { status: 400 })
  const body = parsed.data

  const updated = await getDb().transaction(async (tx) => {
    const [old] = await tx.select({ mrp: medications.mrpPerUnitPaise, gst: medications.gstRateBp }).from(medications).where(eq(medications.id, id)).for('update')
    if (!old) return null
    const [row] = await tx.update(medications).set({
      mrpPerUnitPaise: body.mrpPerUnitPaise,
      ...(body.gstRateBp !== undefined ? { gstRateBp: body.gstRateBp } : {}),
      ...(body.hsn !== undefined ? { hsn: body.hsn } : {}),
    }).where(eq(medications.id, id)).returning({ id: medications.id, mrpPerUnitPaise: medications.mrpPerUnitPaise, gstRateBp: medications.gstRateBp, hsn: medications.hsn })
    await logAudit(session, 'set medication price', null,
      `medication=${id} mrp=${old.mrp ?? 'none'}→${row.mrpPerUnitPaise} gst=${old.gst ?? 'default'}→${row.gstRateBp ?? 'default'}`, tx)
    return row
  })
  if (!updated) return NextResponse.json({ error: 'Medication not found' }, { status: 404 })
  return NextResponse.json({ medication: updated })
}
