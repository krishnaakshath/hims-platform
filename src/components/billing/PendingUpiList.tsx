'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { FIELD_CLASS } from '@/components/tariff/api'
import { sendJson } from '@/lib/client-fetch'
import { formatPaise } from '@/lib/format'
import { formatDateTimeIn } from '@/lib/india-time'
import { UTR_PATTERN, normaliseUtr } from '@/lib/payments/provider'
import type { PendingUpiRequestRow } from '@/lib/payments/manual-upi'

// WS7 T8 (spec D14): the patient's UPI requests still awaiting confirmation -- cash desk QRs and
// portal "Pay now" requests. A patient-reported UTR is shown masked (last four only); the cashier
// types the full UTR from the bank statement and confirms through the existing confirm route,
// which posts the one receipt. A UTR the patient typed never posts anything by itself.
export function PendingUpiList({ requests }: { requests: PendingUpiRequestRow[] }) {
  return (
    <ul className="divide-y divide-border rounded-md border border-border text-sm">
      {requests.map((r) => <PendingUpiItem key={r.id} request={r} />)}
    </ul>
  )
}

function PendingUpiItem({ request: r }: { request: PendingUpiRequestRow }) {
  const router = useRouter()
  const [utr, setUtr] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const valid = UTR_PATTERN.test(normaliseUtr(utr))
  const inputId = `pending-upi-${r.id}`

  async function confirm(e: React.FormEvent) {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    const res = await sendJson<{ receiptNumber: string }>(`/api/billing/payments/upi-request/${r.id}/confirm`, 'POST', { utr: utr.trim() })
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setUtr('')
    setReceipt(res.data.receiptNumber)
    router.refresh()
  }

  return (
    <li className="space-y-2 px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span>
          <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">{r.source === 'portal' ? 'Patient portal' : 'Cash desk'}</span>
          {r.invoiceNumber ? `Bill ${r.invoiceNumber}` : 'Payment'} · {formatDateTimeIn(r.createdAt)}
        </span>
        <span className="font-semibold tabular-nums">{formatPaise(r.amountPaise)}</span>
      </div>
      {r.reportedUtrMasked && <p className="text-xs text-muted-foreground">Patient reported UTR {r.reportedUtrMasked}</p>}
      {receipt ? (
        <p role="status" className="text-xs text-foreground">Recorded {receipt}</p>
      ) : (
        <form onSubmit={confirm} className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor={inputId} className="mb-1 block text-xs font-medium text-muted-foreground">
              UTR{' '}<span className="sr-only">for request {r.id}</span>{' '}(check it on the bank statement)
            </label>
            <input id={inputId} value={utr} onChange={(e) => setUtr(e.target.value)} autoComplete="off" maxLength={40} className={`${FIELD_CLASS} w-48 font-mono`} />
          </div>
          <Button type="submit" disabled={busy || !valid}>Confirm{' '}<span className="sr-only">payment request {r.id}</span></Button>
        </form>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </li>
  )
}
