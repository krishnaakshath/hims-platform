'use client'
import { formatIstDateTime } from '@/lib/india-time'
import { formatPaise } from '@/lib/format'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { sendJson } from '@/lib/client-fetch'
import type { DispenseBilling } from '@/lib/queries/medication-dispenses'

export interface PharmacyBillingRowView {
  dispenseId: number
  patientId: string
  patientName: string
  uhid: string | null
  medicationName: string
  quantity: number
  dispensedByName: string
  dispensedAt: string
  billing: DispenseBilling
}

// WS2 T8: a dispense bills itself; the status comes from its charge line. Only a legacy dispense
// (made before that, never billed) offers "Bill at current price".
export function DispenseBillingStatus({ billing }: { billing: DispenseBilling }) {
  switch (billing.status) {
    case 'billed': return <span className="text-foreground">{billing.lineStatus === 'invoiced' ? 'Invoiced' : 'On the bill'} · {formatPaise(billing.totalPaise)}</span>
    case 'legacy_charge': return <span className="text-foreground">Billed (old charge) · {formatPaise(billing.amountPaise)}</span>
    case 'no_charge': return <span className="text-muted-foreground">No charge</span>
    case 'voided': return <span className="text-warning">Charge voided</span>
    case 'unbilled': return <span className="text-warning">Not billed</span>
  }
}

export function BillLegacyDispenseButton({ dispenseId, onBilled }: { dispenseId: number; onBilled: () => void }) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function bill() {
    setSubmitting(true)
    setError(null)
    const res = await sendJson(`/api/pharmacy/dispenses/${dispenseId}/charge`, 'POST', {})
    setSubmitting(false)
    if (res.ok) { onBilled(); return }
    setError(res.error)
  }

  return (
    <div>
      <Button size="sm" variant="outline" disabled={submitting} onClick={bill}>{submitting ? 'Billing…' : 'Bill at current price'}</Button>
      {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}

export function PharmacyBillingTable({ rows }: { rows: PharmacyBillingRowView[] }) {
  const router = useRouter()

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-secondary/40 text-left">
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Medication</th>
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Qty</th>
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dispensed by</th>
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Date</th>
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Billing</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.dispenseId} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
              <td className="p-3 font-medium text-foreground">{r.patientName}{r.uhid && <span className="font-mono text-xs text-muted-foreground"> ({r.uhid})</span>}</td>
              <td className="p-3 text-foreground">{r.medicationName}</td>
              <td className="p-3 text-foreground">{r.quantity}</td>
              <td className="p-3 text-foreground">{r.dispensedByName}</td>
              <td className="p-3 text-foreground">{formatIstDateTime(r.dispensedAt)}</td>
              <td className="p-3">
                {r.billing.status === 'unbilled'
                  ? <BillLegacyDispenseButton dispenseId={r.dispenseId} onBilled={() => router.refresh()} />
                  : <DispenseBillingStatus billing={r.billing} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
