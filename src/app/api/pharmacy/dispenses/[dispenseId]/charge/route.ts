import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { diagnoses, patients } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getDispenseById, createChargeForDispense } from '@/lib/queries/medication-dispenses'

const dispenseChargeSchema = z.object({
  diagnosisId: z.number().int(),
  procedureCode: z.string().trim().min(1),
  procedureDescription: z.string().trim().min(1),
  unitChargeCents: z.number().int().positive(),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ dispenseId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['pharmacy', 'admin'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { dispenseId } = await params
  const id = Number(dispenseId)
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'Invalid dispenseId' }, { status: 400 })

  const dispense = await getDispenseById(id)
  if (!dispense) return NextResponse.json({ error: 'Dispense not found' }, { status: 404 })

  if (dispense.chargeId !== null) {
    return NextResponse.json({ error: 'This dispense has already been billed' }, { status: 409 })
  }

  const parsed = dispenseChargeSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid charge payload', details: parsed.error.flatten() }, { status: 400 })

  // Scoped column selects -- not `.select()` -- on both diagnoses and
  // patients below: the live tables (per a concurrent worktree's migration)
  // no longer have every column the Drizzle schema still declares (e.g.
  // diagnoses.source; patients' nameTebra/nameIntakeq/dobTebra/dobIntakeq),
  // so a whole-row select 500s. id/code/description and currentProvider are
  // real columns on both. Same pattern as getPatientPharmacyView
  // (patients.ts:218-224).
  const patientDiagnoses = await getDb()
    .select({ id: diagnoses.id, code: diagnoses.code, description: diagnoses.description })
    .from(diagnoses)
    .where(eq(diagnoses.patientId, dispense.patientId))
  const diagnosis = patientDiagnoses.find((d) => d.id === parsed.data.diagnosisId)
  if (!diagnosis) return NextResponse.json({ error: 'diagnosisId does not belong to this patient' }, { status: 400 })

  const [patient] = await getDb().select({ currentProvider: patients.currentProvider }).from(patients).where(eq(patients.id, dispense.patientId))
  const providerName = patient?.currentProvider ?? dispense.dispensedByName

  const amountCents = dispense.quantity * parsed.data.unitChargeCents

  const result = await createChargeForDispense({
    dispenseId: dispense.id,
    patientId: dispense.patientId,
    providerName,
    dateOfService: dispense.dispensedAt.toISOString().slice(0, 10),
    diagnosisCode: { code: diagnosis.code, description: diagnosis.description },
    procedureCode: {
      code: parsed.data.procedureCode,
      description: parsed.data.procedureDescription,
      units: dispense.quantity,
      chargeCents: parsed.data.unitChargeCents,
    },
    amountCents,
  })

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })

  await logAudit(session, 'logged a bill for a dispensed medication', dispense.patientId)
  return NextResponse.json({ chargeId: result.chargeId }, { status: 201 })
}
