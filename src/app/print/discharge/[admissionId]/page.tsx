import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CLINICAL_ROLES, DISCHARGE_SUMMARY_PRINT_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { parseId } from '@/lib/http'
import { getDischargeSummaryData } from '@/lib/queries/discharge-summary'
import { getPracticeIdentity } from '@/lib/queries/settings'
import { formatIsoDate, formatIstDate, formatIstDateTime } from '@/lib/india-time'
import type { DischargeSummaryData } from '@/lib/encounters/discharge-summary'
import { DocField, DocSection, PrintDocument } from '@/components/print/PrintDocument'

// Wave F P1-13: the printable A4 discharge summary (SP3 promised it; the data
// loader and builder had no consumer). Gated right after the session check,
// before any query, to DISCHARGE_SUMMARY_PRINT_ROLES. The builder decides the
// clinical content by role: clinical roles get the five Ds, coded diagnoses,
// stay medicines, labs, ABHA and the MLC number; the front desk gets the
// administrative copy. Only DISCHARGED admissions have a summary (404
// otherwise). Every render is an audited read. No national ID of any kind.

const ADMISSION_TYPE_LABEL: Record<DischargeSummaryData['admission']['admissionType'], string> = {
  elective: 'Elective',
  emergency: 'Emergency',
  transfer_in: 'Transfer in',
}
const DX_TYPE_LABEL = { primary: 'Primary', secondary: 'Secondary', provisional: 'Provisional' } as const
const SYSTEM_LABEL = { icd10: 'ICD-10', icd10pcs: 'ICD-10-PCS', snomed: 'SNOMED CT', loinc: 'LOINC', hbp: 'HBP' } as const
const FOLLOW_UP_STATUS_LABEL: Record<string, string> = { planned: 'Planned (not yet booked)', scheduled: 'Booked', completed: 'Completed', missed: 'Missed', cancelled: 'Cancelled' }

const TH = 'border-b border-neutral-400 px-1.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wide'
const TD = 'border-b border-neutral-200 px-1.5 py-1 align-top'

function TextBlock({ value }: { value: string }) {
  return value.trim() ? <p className="whitespace-pre-line">{value}</p> : <p className="text-neutral-500">Not recorded</p>
}

export default async function DischargeSummaryPrintPage({ params }: { params: Promise<{ admissionId: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!DISCHARGE_SUMMARY_PRINT_ROLES.includes(session.role)) redirect('/')

  const { admissionId: raw } = await params
  const admissionId = parseId(raw)
  if (admissionId === null) notFound()

  const now = new Date()
  const data = await getDischargeSummaryData(admissionId, { now, viewerRole: session.role })
  if (!data) notFound()
  const practice = await getPracticeIdentity()
  await logAudit(session, 'printed discharge summary', data.patient.id, `admission=${data.admission.id}`)

  const { patient: p, admission: a, attending: doc, clinical, record, followUp: f, signature: s } = data
  const clinicalCopy = CLINICAL_ROLES.includes(session.role) && clinical !== null

  return (
    <PrintDocument
      title="Discharge summary"
      backHref={`/patients/${p.id}`}
      backLabel="Back to patient"
      hospitalName={practice.practiceName ?? data.hospitalName}
      hospitalSubline={practice.practiceSite}
      meta={[
        { label: 'IP No.', value: `IP-${a.id}` },
        { label: 'Discharged', value: formatIsoDate(a.dischargedOn) },
      ]}
      printedAt={now}
    >
      {!clinicalCopy && (
        <p className="mt-3 rounded border border-neutral-400 px-3 py-1.5 text-xs font-semibold">
          Administrative copy: clinical details are not included for your role.
        </p>
      )}
      {p.isMlc && (
        <p className="mt-3 rounded border-2 border-black px-3 py-1 text-xs font-bold uppercase tracking-wide">
          Medico-legal case{p.mlcNumber ? ` — MLC No. ${p.mlcNumber}` : ''}
        </p>
      )}

      <dl className="mt-4 grid grid-cols-4 gap-x-4 gap-y-2 border-b border-neutral-300 pb-3">
        <div className="col-span-2">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-neutral-600">Patient</dt>
          <dd className="text-base font-semibold">{p.name}</dd>
        </div>
        <DocField label="UHID"><span className="font-mono">{p.uhid ?? 'UHID not issued'}</span></DocField>
        <DocField label="Age / Sex">{`${p.ageYears} y / ${p.gender ?? '—'}`}</DocField>
        <DocField label="Admitted">{formatIsoDate(a.admittedOn)}</DocField>
        <DocField label="Discharged">{formatIsoDate(a.dischargedOn)}</DocField>
        <DocField label="Length of stay">{`${a.lengthOfStayDays} ${a.lengthOfStayDays === 1 ? 'day' : 'days'}`}</DocField>
        <DocField label="Admission type">{ADMISSION_TYPE_LABEL[a.admissionType]}</DocField>
        <DocField label="Ward">{a.lastWard ?? '—'}</DocField>
        <DocField label="Department">{doc.departmentName ?? '—'}</DocField>
        <div className="col-span-2">
          <DocField label="Consultant">
            {doc.name}
            <span className="block text-xs font-normal">{doc.registration ? `Reg. No. ${doc.registration}` : 'Reg. No. not on file'}</span>
          </DocField>
        </div>
        {p.abhaNumber && <DocField label="ABHA number"><span className="font-mono">{p.abhaNumber}</span></DocField>}
        {p.abhaAddress && <DocField label="ABHA address">{p.abhaAddress}</DocField>}
        {p.address && <div className="col-span-4"><DocField label="Address">{p.address}</DocField></div>}
      </dl>

      {clinicalCopy && clinical && (
        <>
          <DocSection title="Final diagnosis">
            <TextBlock value={clinical.diagnosis} />
            {record && record.diagnoses.length > 0 && (
              <table aria-label="Coded diagnoses" className="mt-2 w-full border-collapse text-[12px]">
                <thead>
                  <tr><th className={TH}>Type</th><th className={TH}>Code</th><th className={TH}>Description</th></tr>
                </thead>
                <tbody>
                  {record.diagnoses.map((d, i) => (
                    <tr key={`${d.code ?? 'nocode'}-${i}`}>
                      <td className={TD}>{d.type ? DX_TYPE_LABEL[d.type] : '—'}</td>
                      <td className={`${TD} whitespace-nowrap`}>
                        {d.code ? (
                          <>
                            <span className="font-mono font-semibold">{d.code}</span>
                            {d.system && <span className="block text-[10px] text-neutral-600">{SYSTEM_LABEL[d.system]}{d.codingStatus === 'proposed' ? ' · provisional code' : ''}</span>}
                          </>
                        ) : <span className="text-neutral-500">Not coded</span>}
                      </td>
                      <td className={TD}>{d.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </DocSection>

          <DocSection title="Hospital course / summary">
            <TextBlock value={clinical.notes} />
          </DocSection>

          {record && (
            <DocSection title="Medicines given during the stay">
              {record.medications.length === 0 ? <p className="text-neutral-500">None recorded on the medication chart.</p> : (
                <table aria-label="Medicines given during the stay" className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr><th className={TH}>Medicine</th><th className={TH}>Dose</th><th className={`${TH} text-right`}>Doses given</th><th className={TH}>From</th><th className={TH}>To</th></tr>
                  </thead>
                  <tbody>
                    {record.medications.map((m) => (
                      <tr key={`${m.name}|${m.dose}`}>
                        <td className={TD}>{m.name}</td>
                        <td className={TD}>{m.dose}</td>
                        <td className={`${TD} text-right tabular-nums`}>{m.given}</td>
                        <td className={`${TD} whitespace-nowrap`}>{m.firstGivenAt ? formatIstDate(m.firstGivenAt) : '—'}</td>
                        <td className={`${TD} whitespace-nowrap`}>{m.lastGivenAt ? formatIstDate(m.lastGivenAt) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </DocSection>
          )}

          {record && (
            <DocSection title="Investigations">
              {record.labs.length === 0 ? <p className="text-neutral-500">No verified results for tests ordered during the stay.</p> : (
                <table aria-label="Investigations" className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr><th className={TH}>Test</th><th className={TH}>Result</th><th className={TH}>Reference</th><th className={TH}>Flag</th><th className={TH}>Date</th></tr>
                  </thead>
                  <tbody>
                    {record.labs.map((l, i) => (
                      <tr key={`${l.testCode}-${i}`}>
                        <td className={TD}>{l.testName}</td>
                        <td className={`${TD} tabular-nums ${l.flag === 'normal' ? '' : 'font-bold'}`}>{l.value}{l.unit ? ` ${l.unit}` : ''}</td>
                        <td className={TD}>{l.referenceRange ?? '—'}</td>
                        <td className={`${TD} capitalize`}>{l.flag}</td>
                        <td className={`${TD} whitespace-nowrap`}>{formatIstDate(l.resultedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {record.labsNotFinal > 0 && (
                <p className="mt-1 text-xs italic">
                  {record.labsNotFinal} {record.labsNotFinal === 1 ? 'test' : 'tests'} ordered during the stay {record.labsNotFinal === 1 ? 'has' : 'have'} no verified result yet.
                </p>
              )}
            </DocSection>
          )}

          <DocSection title="Discharge medications">
            <TextBlock value={clinical.drugs} />
          </DocSection>
          <div className="grid grid-cols-2 gap-x-6">
            <DocSection title="Devices / lines"><TextBlock value={clinical.devices} /></DocSection>
            <DocSection title="Diet & activity"><TextBlock value={clinical.diet} /></DocSection>
          </div>
        </>
      )}

      <DocSection title="Follow-up plan">
        {f ? (
          <dl className="grid grid-cols-3 gap-x-4 gap-y-1">
            <div className="col-span-3"><DocField label="Reason">{f.reason}</DocField></div>
            <DocField label="Review due">{formatIsoDate(f.dueDate)}</DocField>
            <DocField label="Window">{`${formatIsoDate(f.windowStart)} – ${formatIsoDate(f.windowEnd)}`}</DocField>
            <DocField label="Status">{FOLLOW_UP_STATUS_LABEL[f.status] ?? f.status}</DocField>
            {f.appointmentStartsAt && <div className="col-span-3"><DocField label="Appointment">{formatIstDateTime(f.appointmentStartsAt, { label: true })}</DocField></div>}
          </dl>
        ) : <p className="text-neutral-500">No follow-up visit was planned at discharge.</p>}
        <p className="mt-2 text-xs">In an emergency, or if symptoms worsen, report to the hospital casualty immediately.</p>
      </DocSection>

      <section className="mt-10 flex items-end justify-between gap-6">
        <p className="text-xs">
          {s
            ? `Signed by ${s.signerTypedName} on ${formatIstDateTime(s.signedAt, { label: true })}`
            : <span className="font-semibold">Not yet signed by the consultant.</span>}
        </p>
        <div className="w-72 text-right">
          <div className="mb-1 border-t border-black pt-1 text-[10px] uppercase tracking-wide text-neutral-600">Consultant&apos;s signature</div>
          <p className="font-semibold">{doc.name}</p>
          <p className="text-xs">{doc.registration ? `Reg. No. ${doc.registration}` : 'Reg. No. not on file'}</p>
        </div>
      </section>
    </PrintDocument>
  )
}
