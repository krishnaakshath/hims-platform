import { ageOnDate, formatIstDate, istDateOf } from '@/lib/india-time'
import { GENDERS } from '@/lib/india/reference'
import { notFound, redirect } from 'next/navigation'
import { parseId } from '@/lib/http'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { getPrintablePrescriptions } from '@/lib/queries/prescriptions'
import { getPatientDocumentIdentity } from '@/lib/queries/print-slips'
import { getPracticeIdentity } from '@/lib/queries/settings'
import { DocField, PrintDocument } from '@/components/print/PrintDocument'
import { brand } from '@/lib/brand'

// Printing is a read of the prescriptions shown on the chart, so it uses the
// chart's gate (CLINICAL_ROLES: admin, crc, pi) -- not narrowed to admin/pi
// (who alone may write a prescription). Every other role is redirected home
// before any query. Every render is audited regardless of role (Step 6
// below).

// Splits on ',', requires every token to be a bare non-negative integer
// (rejects '', 'abc', a trailing empty token from '1,', a leading '-', and
// anything past int4 -- see parseId),
// de-duplicates, and bounds the result to 1-20 entries -- a cap on a
// URL-supplied fan-out, not a product limit.
function parseIds(raw: string | undefined): number[] | null {
  if (!raw) return null
  const tokens = raw.split(',')
  const ids: number[] = []
  for (const token of tokens) {
    const id = parseId(token)
    if (id === null) return null
    ids.push(id)
  }
  const unique = Array.from(new Set(ids))
  if (unique.length < 1 || unique.length > 20) return null
  return unique
}

const GENDER_LABEL = new Map<string, string>(GENDERS.map((g) => [g.code, g.label]))

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

  const patient = await getPatientDocumentIdentity(rows[0].patientId)
  // Defensive only: getPrintablePrescriptions already guarantees
  // medication_episodes.patient_id references a real patient row.
  if (!patient) notFound()

  const practice = await getPracticeIdentity()

  // After validation, so a rejected URL writes no audit row, and on every
  // successful render, so every print is an audited PHI access.
  await logAudit(session, `printed prescription(s) ${ids.join(',')}`, rows[0].patientId)

  const first = rows[0]
  // Wave F P1-16: the age on the (IST) date the prescription was written.
  const writtenOn = istDateOf(first.prescribedAt)
  const age = ageOnDate(patient.dob, writtenOn)
  const sex = patient.gender ? (GENDER_LABEL.get(patient.gender) ?? patient.gender) : '—'

  return (
    <PrintDocument
      title="Prescription"
      backHref={`/patients/${patient.id}/medical-record`}
      backLabel="Back to Medical Record"
      hospitalName={practice.practiceName ?? brand.legalName}
      hospitalSubline={practice.practiceSite}
      meta={[{ label: 'Date', value: formatIstDate(first.prescribedAt) }]}
      printedAt={new Date()}
    >
      <dl className="mt-4 grid grid-cols-4 gap-x-4 gap-y-2 border-b border-neutral-300 pb-3">
        <div className="col-span-2">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-neutral-600">Patient</dt>
          <dd className="text-base font-semibold">{patient.name}</dd>
        </div>
        <DocField label="UHID"><span className="font-mono">{patient.uhid ?? 'UHID not issued'}</span></DocField>
        <DocField label="Age / Sex">{`${age} y / ${sex}`}</DocField>
      </dl>

      <section className="mt-5" aria-label="Medicines">
        <p className="mb-2 font-serif text-3xl font-bold italic leading-none">Rx</p>
        <ol className="space-y-3">
          {rows.map((row, i) => (
            <li key={row.id} className="grid grid-cols-[1.5rem_1fr] gap-x-2 border-b border-neutral-200 pb-2 last:border-b-0">
              <span className="font-semibold tabular-nums">{i + 1}.</span>
              <div>
                <p className="font-semibold">
                  {row.name} <span className="font-normal text-neutral-600">({row.medicationClass})</span>
                </p>
                <div className="flex flex-wrap gap-x-4 text-[13px]">
                  {row.dose && <p>{row.dose}</p>}
                  <p>{row.frequencyPerDay} times daily</p>
                  <p>for {row.durationDays} days</p>
                </div>
                {row.instructions && <p className="text-xs italic">{row.instructions}</p>}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-12 flex items-end justify-between gap-6">
        <div className="text-xs text-neutral-700">
          {first.enteredByName && first.enteredByName !== first.prescriber.name && <p>Entered by: {first.enteredByName}</p>}
        </div>
        <div className="w-72 text-right">
          <div className="mb-1 border-t border-black pt-1 text-[10px] uppercase tracking-wide text-neutral-600">Signature</div>
          <p className="font-semibold">
            {first.prescriber.name}
            {first.prescriber.credentials ? `, ${first.prescriber.credentials}` : ''}
          </p>
          {first.prescriber.specialty && <p className="text-xs">{first.prescriber.specialty}</p>}
          <p className="text-xs">{first.prescriberRegistration ? `Reg. No. ${first.prescriberRegistration}` : 'Reg. No. not on file'}</p>
        </div>
      </section>

      <p className="mt-6 text-[10px] text-neutral-600">
        This printout is a record of a prescription entered in {brand.name}. It was not transmitted electronically to a pharmacy.
      </p>
    </PrintDocument>
  )
}
