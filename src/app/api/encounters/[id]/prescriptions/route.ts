import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { PRESCRIBE_ROLES } from '@/lib/role-policy'
import { checkEncounterWriter, parseEncounterId } from '@/lib/encounters/ownership'
import { createPrescriptionSetSchema } from '@/lib/prescriptions/validation'
import { createPrescriptionSet } from '@/lib/queries/prescriptions'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import { RETRY_MESSAGE, isRetryableConflict, pgErrorCode } from '@/lib/db-errors'

// WS1 T6: write a multi-drug prescription on a visit (spec rulings 8 and 9). admin, or the pi who
// owns the encounter. Dose is mandatory; an allergy conflict needs allergyOverrideReason (422
// allergy_conflict lists the item indexes otherwise, and nothing is written).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PRESCRIBE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const encounterId = parseEncounterId((await params).id)
  if (encounterId === null) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = createPrescriptionSetSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid prescription', details: parsed.error.flatten() }, { status: 400 })

  const check = await checkEncounterWriter(session, encounterId)
  if (!check.ok) return NextResponse.json(check.body, { status: check.status })

  try {
    // A pi prescribes as themselves (the owner); admin writes on behalf of the visit's doctor.
    const result = await createPrescriptionSet({
      encounter: check.encounter,
      prescribedByProviderId: check.actingProviderId ?? check.encounter.providerId,
      advice: parsed.data.advice || null,
      items: parsed.data.items,
    }, session)
    if (!result.ok) {
      if (result.error === 'visit_closed') return NextResponse.json({ error: 'Visit is closed', code: 'visit_closed' }, { status: 409 })
      if (result.error === 'medication_not_found') {
        return NextResponse.json({ error: 'That medicine is not in the catalogue.', code: 'medication_not_found', index: result.index }, { status: 422 })
      }
      return NextResponse.json({ error: 'This prescription conflicts with a recorded allergy.', code: 'allergy_conflict', conflicts: result.conflicts }, { status: 422 })
    }
    await invalidateCache(patientDetailCacheKey(check.encounter.patientId))
    return NextResponse.json({ prescriptionId: result.prescriptionId, episodeIds: result.episodeIds }, { status: 201 })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[prescriptions] write failed (code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not save the prescription' }, { status: 500 })
  }
}
