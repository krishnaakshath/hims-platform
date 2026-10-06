'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { LogDispenseBillModal } from '@/components/LogDispenseBillModal'
import { CHARGE_STATUS_LABELS, type ChargeStatus } from '@/lib/charge-status'

export interface PharmacyBillingRowView {
  dispenseId: number
  patientId: string
  patientName: string
  medicationName: string
  quantity: number
  dispensedByName: string
  dispensedAt: string
  charge: { id: number; status: ChargeStatus; amountCents: number } | null
}

export function PharmacyBillingTable({ rows }: { rows: PharmacyBillingRowView[] }) {
  const router = useRouter()
  const [billing, setBilling] = useState<{ dispenseId: number; medicationName: string; quantity: number; diagnoses: { id: number; code: string; description: string }[] } | null>(null)
  const [loadingId, setLoadingId] = useState<number | null>(null)

  async function openBilling(row: PharmacyBillingRowView) {
    setLoadingId(row.dispenseId)
    const res = await fetch(`/api/pharmacy/patients/${encodeURIComponent(row.patientId)}`)
    setLoadingId(null)
    if (!res.ok) return
    const view = await res.json()
    setBilling({ dispenseId: row.dispenseId, medicationName: row.medicationName, quantity: row.quantity, diagnoses: view.diagnoses ?? [] })
  }

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
              <td className="p-3 font-medium text-foreground">{r.patientName} <span className="font-mono text-xs text-muted-foreground">({r.patientId})</span></td>
              <td className="p-3 text-foreground">{r.medicationName}</td>
              <td className="p-3 text-foreground">{r.quantity}</td>
              <td className="p-3 text-foreground">{r.dispensedByName}</td>
              <td className="p-3 text-foreground">{new Date(r.dispensedAt).toLocaleString()}</td>
              <td className="p-3">
                {r.charge === null ? (
                  <Button size="sm" variant="outline" disabled={loadingId === r.dispenseId} onClick={() => openBilling(r)}>
                    {loadingId === r.dispenseId ? 'Loading…' : 'Log bill'}
                  </Button>
                ) : (
                  <span className="text-foreground">{CHARGE_STATUS_LABELS[r.charge.status]} · ${(r.charge.amountCents / 100).toFixed(2)}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {billing && (
        <LogDispenseBillModal
          dispense={{ id: billing.dispenseId, medicationName: billing.medicationName, quantity: billing.quantity }}
          diagnoses={billing.diagnoses}
          onClose={() => setBilling(null)}
          onLogged={() => router.refresh()}
        />
      )}
    </div>
  )
}
