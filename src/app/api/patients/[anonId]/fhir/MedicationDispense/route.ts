import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { gatherPatientFhirData } from '@/lib/fhir/gather'
import { medicationDispensesToFhir } from '@/lib/fhir/medication-dispense'
import { buildBundle } from '@/lib/fhir/bundle'

export async function GET(_request: Request, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  const data = await gatherPatientFhirData(anonId)
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await logAudit(session, 'exported FHIR MedicationDispense bundle', anonId)
  return new NextResponse(JSON.stringify(buildBundle(medicationDispensesToFhir(data.dispenseRows))), {
    headers: {
      'Content-Type': 'application/fhir+json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${anonId}-fhir-medicationdispense.json"`,
    },
  })
}
