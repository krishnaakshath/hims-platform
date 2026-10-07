import { formatIstDate } from '@/lib/india-time'
import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { getPrintablePrescriptions } from '@/lib/queries/prescriptions'
import { getPatientIdentityForPrint } from '@/lib/queries/patients'
import { getPracticeIdentity } from '@/lib/queries/settings'
import { BackLink } from '@/components/BackLink'
import { PrintButton } from '@/components/PrintButton'
import { brand } from '@/lib/brand'

// Printing is a read of the prescriptions shown on the chart, so it uses the
// chart's gate (CLINICAL_ROLES: admin, crc, pi) -- not narrowed to admin/pi
// (who alone may write a prescription). Every other role is redirected home
// before any query. Every render is audited regardless of role (Step 6
// below).

// Splits on ',', requires every token to be a bare non-negative integer
// (rejects '', 'abc', a trailing empty token from '1,', and a leading '-'),
// de-duplicates, and bounds the result to 1-20 entries -- a cap on a
// URL-supplied fan-out, not a product limit.
function parseIds(raw: string | undefined): number[] | null {
  if (!raw) return null
  const tokens = raw.split(',')
  const ids: number[] = []
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) return null
    ids.push(Number(token))
  }
  const unique = Array.from(new Set(ids))
  if (unique.length < 1 || unique.length > 20) return null
  return unique
}

function formatLongDate(value: Date | string): string {
  return formatIstDate(value)
}

export default async function PrescriptionPrintPage({ searchParams }: { searchParams: Promise<{ ids?: string }> }) {
  // First statement, per requireSessionOrRedirect's own documented
  // requirement -- see src/lib/auth.ts.
  const session = await requireSessionOrRedirect()
  if (!CLINICAL_ROLES.includes(session.role)) redirect('/')

  const { ids: idsParam } = await searchParams
  const ids = parseIds(idsParam)
  if (!ids) notFound()

  // Every id exists, they share one patient, and every one has a
  // prescribedAt and a resolvable prescriber -- all three substantive
  // checks live in this one function (Task 3). A null result collapses
  // every one of those failure modes, including the mixed-patient PHI
  // disclosure case, into the same 404.
  const rows = await getPrintablePrescriptions(ids)
  if (!rows) notFound()

  const patient = await getPatientIdentityForPrint(rows[0].patientId)
  // Defensive only: getPrintablePrescriptions already guarantees
  // medication_episodes.patient_id references a real patient row.
  if (!patient) notFound()

  const practice = await getPracticeIdentity()

  // After validation, so a rejected URL writes no audit row, and on every
  // successful render, so every print is an audited PHI access.
  await logAudit(session, `printed prescription(s) ${ids.join(',')}`, rows[0].patientId)

  const first = rows[0]

  return (
    <div className="mx-auto max-w-2xl px-8 py-10 text-foreground">
      <div className="no-print mb-8 flex items-center justify-between">
        <BackLink href={`/patients/${patient.id}/medical-record`} label="Back to Medical Record" />
        <PrintButton />
      </div>

      <header className="mb-8 border-b border-border pb-4">
        <p className="text-lg font-semibold">{practice.practiceName ?? brand.legalName}</p>
        {practice.practiceSite && <p className="text-sm text-muted-foreground">{practice.practiceSite}</p>}
      </header>

      <section className="mb-6">
        <p className="text-base font-semibold">{patient.name}</p>
        <p className="text-sm text-muted-foreground">Patient ID: {patient.id}</p>
        <p className="text-sm text-muted-foreground">DOB: {patient.dob}</p>
      </section>

      <p className="mb-8 text-sm">Date written: {formatLongDate(first.prescribedAt)}</p>

      <section className="mb-8 space-y-6">
        {rows.map((row) => (
          <div key={row.id} className="border-b border-border pb-4 last:border-b-0">
            <p className="font-semibold">
              {row.name} <span className="font-normal text-muted-foreground">({row.medicationClass})</span>
            </p>
            {row.dose && <p>{row.dose}</p>}
            <p>{row.frequencyPerDay} times daily</p>
            <p>for {row.durationDays} days</p>
            {row.instructions && <p className="text-sm">{row.instructions}</p>}
          </div>
        ))}
      </section>

      <section className="mb-8">
        <p className="font-semibold">
          {first.prescriber.name}
          {first.prescriber.credentials ? `, ${first.prescriber.credentials}` : ''}
        </p>
        {first.prescriber.specialty && <p className="text-sm text-muted-foreground">{first.prescriber.specialty}</p>}
        <div className="mt-12 w-64 border-t border-foreground pt-1 text-xs text-muted-foreground">Signature</div>
      </section>

      {first.enteredByName && first.enteredByName !== first.prescriber.name && (
        <p className="mb-8 text-sm text-muted-foreground">Entered by: {first.enteredByName}</p>
      )}

      <footer className="border-t border-border pt-4 text-xs text-muted-foreground">
        This printout is a record of a prescription entered in {brand.name}. It was not transmitted electronically to a pharmacy.
      </footer>
    </div>
  )
}
