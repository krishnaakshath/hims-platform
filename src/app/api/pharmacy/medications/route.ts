import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listMedicationsWithInventory, createMedicationWithInventory } from '@/lib/queries/medications'

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  return NextResponse.json(await listMedicationsWithInventory())
}

const createMedicationSchema = z.object({
  name: z.string().trim().min(1),
  genericName: z.string().trim().min(1).optional(),
  medicationClass: z.string().trim().min(1),
  commonDose: z.string().trim().min(1).optional(),
  form: z.enum(['tablet', 'capsule', 'liquid', 'injection', 'other']),
  quantityOnHand: z.number().int().nonnegative(),
  reorderThreshold: z.number().int().nonnegative(),
  unit: z.string().trim().min(1),
}).strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'pharmacy'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = createMedicationSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid medication payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await createMedicationWithInventory({
    name: parsed.data.name,
    genericName: parsed.data.genericName ?? null,
    medicationClass: parsed.data.medicationClass,
    commonDose: parsed.data.commonDose ?? null,
    form: parsed.data.form,
    quantityOnHand: parsed.data.quantityOnHand,
    reorderThreshold: parsed.data.reorderThreshold,
    unit: parsed.data.unit,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })

  await logAudit(session, 'added a medication to the catalog', null)
  return NextResponse.json({ id: result.medicationId }, { status: 201 })
}
