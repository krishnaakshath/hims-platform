import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { REGISTRATION_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { getRegistrationSlip } from '@/lib/queries/print-slips'
import { formatIsoDate, istDateOf } from '@/lib/india-time'
import { PrintSlip } from '@/components/print/PrintSlip'

// Wave C: registration slip / UHID card, printed after registration (and
// reprintable from the patient page). Registration roles only, gated right
// after the session check, before any query. Name, UHID and the IST
// registration date -- never DOB, phone, Aadhaar or ABHA.
export default async function RegistrationSlipPage({ params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!REGISTRATION_ROLES.includes(session.role)) redirect('/')

  const { anonId } = await params
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(anonId)) notFound()

  const slip = await getRegistrationSlip(anonId)
  if (!slip) notFound()
  await logAudit(session, 'printed registration slip', slip.id)

  return (
    <PrintSlip title="Patient registration" backHref={`/patients/${slip.id}`} backLabel="Back to patient">
      <section className="space-y-1 py-3">
        <p className="text-base font-semibold leading-tight">{slip.name}</p>
        <p className="text-[11px] uppercase tracking-wide text-black/70">UHID</p>
        {slip.uhid ? (
          <p className="font-mono text-2xl font-bold tracking-wider">{slip.uhid}</p>
        ) : (
          <>
            <p className="text-sm font-semibold">UHID not issued</p>
            <p className="font-mono text-[11px] text-black/70">Chart ID {slip.id}</p>
          </>
        )}
      </section>
      <section className="border-t border-dashed border-black/40 pt-2 text-left text-xs">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-black/70">Registered on</span>
          <span className="font-medium">{formatIsoDate(istDateOf(new Date(slip.registeredAt)))}</span>
        </div>
      </section>
      <p className="mt-3 border-t border-dashed border-black/40 pt-2 text-[10px] text-black/70">Please bring this card on every visit and quote your UHID at the counter.</p>
    </PrintSlip>
  )
}
