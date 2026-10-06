import { NextResponse } from 'next/server'
import { requirePatientSession } from '@/lib/patient-session'
import { getPatientPortalData } from '@/lib/queries/patient-portal'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'

export async function GET() {
  const session = await requirePatientSession()
  if (session instanceof NextResponse) return session

  const data = await getPatientPortalData(session.patientId)
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const lines = [
    `Medication summary for ${data.name} (${data.id})`,
    `Generated ${new Date().toLocaleString()}`,
    '',
    'CURRENT MEDICATIONS',
    ...(data.activeMedications.length === 0
      ? ['  None on file']
      : data.activeMedications.map((m) => `  - ${m.name} (${m.medicationClass}), ${m.dose ?? 'dose not on file'} -- started ${m.startDate}`)),
    '',
    'PAST MEDICATIONS',
    ...(data.pastMedications.length === 0
      ? ['  None on file']
      : data.pastMedications.map((m) => `  - ${m.name} (${m.medicationClass}), ${m.dose ?? 'dose not on file'} -- ${m.startDate} to ${m.stopDate ?? 'unknown'}`)),
    '',
    'This summary reflects the medications on file at the time it was generated and is not a substitute for a pharmacy label or prescriber instructions.',
  ]

  await logPatientPortalAction('downloaded medication summary via patient portal', session.patientId)

  return new NextResponse(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="medications-${data.id}.txt"`,
    },
  })
}
