import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getCharge } from '@/lib/queries/charges'
import { formatCents } from '@/lib/format'
import { CHARGE_STATUS_LABELS, type ChargeStatus } from '@/lib/charge-status'

// Same status -> dot color mapping as ChargesTable's list view, so a charge's
// status reads identically whether seen in the list or in this detail view.
const STATUS_DOT: Record<ChargeStatus, string> = {
  draft: 'bg-muted-foreground',
  pending_approval: 'bg-warning',
  approved: 'bg-primary',
  submitted: 'bg-success',
}

export default async function ChargeCaptureDetailPage({ params }: { params: Promise<{ chargeId: string }> }) {
  // Must be the first statement — see the comment in patients/page.tsx.
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:98 — the Billing group is rendered for admin/crc/frontdesk
  // only. Must precede notFound() below, not follow it.
  if (!['admin', 'crc', 'billing'].includes(session.role)) redirect('/')

  const { chargeId } = await params
  const charge = await getCharge(Number(chargeId))
  if (!charge) notFound()
  await logAudit(session, `viewed charge capture ${chargeId}`, charge.patientId)

  return (
    <div className="max-w-3xl space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/billing/charges" className="text-sm text-primary hover:underline">&larr; Back to Charges</Link>
          <h1 className="mt-1 text-2xl font-bold text-foreground">Charge Capture — {charge.patientName}</h1>
        </div>
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <span className={`h-2 w-2 rounded-full ${STATUS_DOT[charge.status]}`} aria-hidden="true" />
          {CHARGE_STATUS_LABELS[charge.status]}
        </span>
      </div>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient Information</h2>
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-4 text-sm">
          <div><span className="text-muted-foreground">Patient: </span><span className="text-foreground">{charge.patientName} ({charge.patientId})</span></div>
          <div><span className="text-muted-foreground">DOB: </span><span className="text-foreground">{charge.patientDob}</span></div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Visit &amp; Provider Information</h2>
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-4 text-sm">
          <div><span className="text-muted-foreground">Date of Service: </span><span className="text-foreground">{charge.dateOfService}</span></div>
          <div><span className="text-muted-foreground">Rendering Provider: </span><span className="text-foreground">{charge.providerName}</span></div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Diagnosis Codes</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Code</th>
              <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</th>
            </tr>
          </thead>
          <tbody>
            {charge.diagnosisCodes.map((d, i) => (
              <tr key={i} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
                <td className="p-2 text-foreground">{d.code}</td>
                <td className="p-2 text-foreground">{d.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Procedure Codes</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Code</th>
              <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</th>
              <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Units</th>
              <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Charge</th>
              <th className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Total</th>
            </tr>
          </thead>
          <tbody>
            {charge.procedureCodes.map((p, i) => (
              <tr key={i} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
                <td className="p-2 text-foreground">{p.code}</td>
                <td className="p-2 text-foreground">{p.description}</td>
                <td className="p-2 text-foreground">{p.units}</td>
                <td className="p-2 text-foreground">{formatCents(p.chargeCents)}</td>
                <td className="p-2 text-foreground">{formatCents(p.chargeCents * p.units)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-right text-sm font-semibold text-foreground">Total: {formatCents(charge.amountCents)}</p>
      </section>
    </div>
  )
}
