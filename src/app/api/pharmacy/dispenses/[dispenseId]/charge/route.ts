import { istDateOf } from '@/lib/india-time'
import { NextRequest, NextResponse } from 'next/server'
import { parseId, readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { liveDiagnosis, withCodeValue } from '@/lib/queries/diagnoses' // SP6
import { getDb } from '@/db/client'
import { diagnoses, patients } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { getDispenseById, createChargeForDispense } from '@/lib/queries/medication-dispenses'
import { MAX_AMOUNT_PAISE } from '@/lib/tariff/validation'

const dispenseChargeSchema = z.object({
  diagnosisId: z.number().int(),
  procedureCode: z.string().trim().min(1),
  procedureDescription: z.string().trim().min(1),
  // SP4: also a charge line's unit price (int4 paise, capped like every unit price).
  unitChargeCents: z.number().int().positive().max(MAX_AMOUNT_PAISE),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ dispenseId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['pharmacy', 'admin'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { dispenseId } = await params
  const id = parseId(dispenseId)
  if (id === null) return NextResponse.json({ error: 'Invalid dispenseId' }, { status: 400 })

  const dispense = await getDispenseById(id)
  if (!dispense) return NextResponse.json({ error: 'Dispense not found' }, { status: 404 })

  if (dispense.chargeId !== null) {
    return NextResponse.json({ error: 'This dispense has already been billed' }, { status: 409 })
  }

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = dispenseChargeSchema.safeParse(json.body)
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
    // SP6: live rows only, and never an uncoded SP6 row (code = '') as a charge's diagnosis code.
    .where(and(eq(diagnoses.patientId, dispense.patientId), liveDiagnosis, withCodeValue))
  const diagnosis = patientDiagnoses.find((d) => d.id === parsed.data.diagnosisId)
  if (!diagnosis) return NextResponse.json({ error: 'diagnosisId does not belong to this patient' }, { status: 400 })

  const [patient] = await getDb().select({ currentProvider: patients.currentProvider }).from(patients).where(eq(patients.id, dispense.patientId))
  const providerName = patient?.currentProvider ?? dispense.dispensedByName

  const amountCents = dispense.quantity * parsed.data.unitChargeCents

  const serviceDate = istDateOf(dispense.dispensedAt)
  const result = await createChargeForDispense({
    dispenseId: dispense.id,
    patientId: dispense.patientId,
    providerName,
    dateOfService: serviceDate,
    serviceDate,
    createdByName: dispense.dispensedByName,
    diagnosisCode: { code: diagnosis.code, description: diagnosis.description },
    procedureCode: {
      code: parsed.data.procedureCode,
      description: parsed.data.procedureDescription,
      units: dispense.quantity,
      chargeCents: parsed.data.unitChargeCents,
    },
    amountCents,
  }, session)

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })

  // The audit row was written on the billing transaction.
  return NextResponse.json({ chargeId: result.chargeId }, { status: 201 })
}
