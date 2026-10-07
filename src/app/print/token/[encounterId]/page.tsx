import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CHECK_IN_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { getTokenSlip } from '@/lib/queries/print-slips'
import { formatDateTimeIn } from '@/lib/india-time'
import { PrintSlip, SlipRow } from '@/components/print/PrintSlip'

// Wave C P1-14: the OPD token slip printed after check-in -- replaces the
// old window.print() of the whole dashboard. Same gate as check-in
// (CHECK_IN_ROLES), right after the session check and before any query.
// Shows the patient's name and UHID (the anonymous chart id only as a
// fallback line), token, doctor, department and the IST check-in time.
export default async function TokenSlipPage({ params }: { params: Promise<{ encounterId: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!CHECK_IN_ROLES.includes(session.role)) redirect('/')

  const { encounterId: raw } = await params
  if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2_147_483_647) notFound()
  const encounterId = Number(raw)

  const slip = await getTokenSlip(encounterId)
  if (!slip) notFound()
  await logAudit(session, 'printed OPD token slip', slip.patient.id, `encounter=${slip.encounterId}`)

  const isOpd = slip.encounterType === 'opd'
  return (
    <PrintSlip title={isOpd ? 'OPD token' : 'Admission check-in'} backHref="/front-desk/check-in" backLabel="Back to Check-In">
      <section className="py-3">
        <p className="text-[11px] uppercase tracking-wide text-black/70">Token</p>
        <p className="text-5xl font-bold leading-none tabular-nums">{slip.opdToken ?? '—'}</p>
      </section>
      <section className="space-y-1 border-t border-dashed border-black/40 pt-2">
        <p className="text-base font-semibold leading-tight">{slip.patient.name}</p>
        <p className="font-mono text-xs">{slip.patient.uhid ? `UHID ${slip.patient.uhid}` : 'UHID not issued'}</p>
        {!slip.patient.uhid && <p className="font-mono text-[11px] text-black/70">Chart ID {slip.patient.id}</p>}
      </section>
      <section className="mt-2 space-y-1 border-t border-dashed border-black/40 pt-2">
        <SlipRow label="Doctor">{slip.doctorName}</SlipRow>
        {slip.departmentName && <SlipRow label="Department">{slip.departmentName}</SlipRow>}
        {slip.room && <SlipRow label="Bed">{`${slip.room.ward} — Room ${slip.room.roomNumber}, Bed ${slip.room.bedNumber}`}</SlipRow>}
        <SlipRow label="Checked in">{formatDateTimeIn(slip.checkedInAt)}</SlipRow>
      </section>
      <p className="mt-3 border-t border-dashed border-black/40 pt-2 text-[10px] text-black/70">Please wait to be called by your token number.</p>
    </PrintSlip>
  )
}
