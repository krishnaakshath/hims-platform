import { NextRequest, NextResponse } from 'next/server'
import { asc, eq, ilike, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { MEDICATION_SEARCH_ROLES } from '@/lib/role-policy'
import { getDb } from '@/db/client'
import { medicationInventory, medications } from '@/db/schema'

const querySchema = z.string().trim().min(2).max(60)

// WS1 T6: the Rx builder's drug picker -- the catalogue by brand or generic name (substring,
// case-insensitive), at most 20 rows, with whether any stock is on hand. Catalogue data only.
export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!MEDICATION_SEARCH_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = querySchema.safeParse(request.nextUrl.searchParams.get('q') ?? '')
  if (!parsed.success) return NextResponse.json({ error: 'Type 2 to 60 characters to search' }, { status: 400 })
  const pattern = `%${parsed.data.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

  const rows = await getDb()
    .select({
      id: medications.id,
      name: medications.name,
      genericName: medications.genericName,
      medicationClass: medications.medicationClass,
      form: medications.form,
      commonDose: medications.commonDose,
      inStock: sql<boolean>`coalesce(${medicationInventory.quantityOnHand}, 0) > 0`,
    })
    .from(medications)
    .leftJoin(medicationInventory, eq(medicationInventory.medicationId, medications.id))
    .where(or(ilike(medications.name, pattern), ilike(medications.genericName, pattern)))
    .orderBy(asc(medications.name))
    .limit(20)

  await logAudit(session, 'searched medications', null, `results=${rows.length}`)
  return NextResponse.json({ items: rows })
}
