'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { sendJson } from '@/lib/client-fetch'
import { formatPaise } from '@/lib/format'
import { UTR_PATTERN, normaliseUtr } from '@/lib/payments/provider'

// WS7 T8 (spec D14): "Pay now" on a portal bill. Shows a UPI QR (and a UPI app link for a phone)
// for what is still owed. After paying, the patient may send the UTR from their UPI app; that only
// tells the hospital where to look -- the bill shows paid once the cashier has confirmed it.
type UpiQr = { requestId: number; qrDataUrl: string; upiUri: string; amountPaise: number }

const INPUT = 'h-11 w-full rounded-md border border-input bg-white px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary'
const BUTTON = 'inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50'

export function PayNowDialog({ invoiceId, invoiceNumber, outstandingPaise }: { invoiceId: number; invoiceNumber: string; outstandingPaise: number }) {
  const router = useRouter()
  const [qr, setQr] = useState<UpiQr | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [utr, setUtr] = useState('')
  const [reported, setReported] = useState(false)

  const utrValid = UTR_PATTERN.test(normaliseUtr(utr))

  async function start() {
    setBusy(true)
    setError(null)
    const res = await sendJson<UpiQr>('/api/patient-portal/payments/upi-request', 'POST', { invoiceId })
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setQr(res.data)
  }

  async function report(e: React.FormEvent) {
    e.preventDefault()
    if (!qr || !utrValid || busy) return
    setBusy(true)
    setError(null)
    const res = await sendJson(`/api/patient-portal/payments/${qr.requestId}/reported-utr`, 'POST', { utr })
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setUtr('')
    setReported(true)
  }

  function close() {
    setQr(null)
    setError(null)
    setUtr('')
    if (reported) router.refresh()
    setReported(false)
  }

  return (
    <>
      <button type="button" className={BUTTON} disabled={busy} onClick={() => void start()}>
        Pay now{' '}<span className="sr-only">{formatPaise(outstandingPaise)} for bill {invoiceNumber}</span>
      </button>
      {error && !qr && <p role="alert" className="basis-full text-sm text-destructive">{error}</p>}
      <Dialog open={qr !== null} onOpenChange={(open) => { if (!open) close() }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Pay by UPI</DialogTitle>
            <DialogDescription>Bill {invoiceNumber}</DialogDescription>
          </DialogHeader>
          {qr && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- a server-rendered data: URL */}
                <img src={qr.qrDataUrl} alt={`UPI QR code for ${formatPaise(qr.amountPaise)}`} width={200} height={200} className="h-48 w-48 rounded bg-white p-1" />
                <p className="text-lg font-semibold tabular-nums">{formatPaise(qr.amountPaise)}</p>
                <p className="text-center text-xs text-muted-foreground">Scan with any UPI app (BHIM, Google Pay, PhonePe, Paytm or your bank&apos;s app).</p>
                <a href={qr.upiUri} className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">Open in a UPI app</a>
              </div>
              {reported ? (
                <p role="status" className="rounded-md bg-secondary/40 p-3 text-sm text-foreground">
                  Thank you. The hospital will confirm your payment and your receipt will appear under Receipts.
                </p>
              ) : (
                <form onSubmit={report} className="space-y-2" aria-label="Send your UPI reference">
                  <label htmlFor={`utr-${invoiceId}`} className="block text-xs font-medium text-muted-foreground">
                    After paying, enter the UTR (UPI reference, usually 12 digits) from your UPI app
                  </label>
                  <input id={`utr-${invoiceId}`} value={utr} onChange={(e) => setUtr(e.target.value)} inputMode="text" autoComplete="off" maxLength={40} className={INPUT} />
                  <p className="text-xs text-muted-foreground">Your bill shows paid once the hospital has confirmed the payment.</p>
                  <button type="submit" className={BUTTON} disabled={busy || !utrValid}>Send reference</button>
                </form>
              )}
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
