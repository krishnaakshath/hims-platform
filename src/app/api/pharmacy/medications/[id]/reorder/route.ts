import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { medicationInventory } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { invalidIdResponse, parseId, readJsonBody } from '@/lib/http'
import { PHARMACY_STOCK_ROLES } from '@/lib/role-policy'

// WS5 T4: the reorder level below which (inclusive) a drug shows as low stock.
const reorderSchema = z.object({ reorderThreshold: z.number().int().min(0).max(100_000) }).strict()

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PHARMACY_STOCK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = parseId((await params).id)
  if (id === null) return invalidIdResponse()
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = reorderSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid reorder level', details: parsed.error.flatten() }, { status: 400 })

  const { reorderThreshold } = parsed.data
  const updated = await getDb().update(medicationInventory).set({ reorderThreshold, updatedAt: new Date() })
    .where(eq(medicationInventory.medicationId, id)).returning({ id: medicationInventory.id })
  if (updated.length === 0) return NextResponse.json({ error: 'Medication not found' }, { status: 404 })
  await logAudit(session, 'pharmacy: changed reorder level', null, `medication=${id} reorder=${reorderThreshold}`)
  return NextResponse.json({ reorderThreshold })
}
