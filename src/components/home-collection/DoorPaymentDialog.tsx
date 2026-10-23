'use client'
// WS6 T12: the collector takes payment at the door, cash or UPI, through the one ledger. The amount
// is prefilled with what is due for the visit's tests (their tariff quotes) and can be changed.
// Cash posts a receipt at once; UPI shows the hospital QR and records the money only when the
// payer's UTR is entered. The receipt number is shown in a toast. The UTR is never shown back.
import { useId, useState } from 'react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { formatPaise, parseRupeesToPaise } from '@/lib/money'
import { UTR_PATTERN, normaliseUtr } from '@/lib/payments/provider'
import { confirmDoorUpi, takeDoorPayment } from '@/components/home-collection/api'
import { FIELD } from '@/components/home-collection/WindowSelect'

const MIN_PAISE = 100
const MAX_PAISE = 10_000_000
const TAP = 'min-h-11 px-4 text-base'

type Upi = { requestId: number; qrDataUrl: string; amountPaise: number }

export function DoorPaymentDialog({
  visit, onClose,
}: { visit: { id: number; patientName: string; amountDuePaise: number; unpricedTests: number }; onClose: () => void }) {
  const id = useId()
  const toast = useToast()
  const [mode, setMode] = useState<'cash' | 'upi'>('cash')
  const [amount, setAmount] = useState(visit.amountDuePaise > 0 ? (visit.amountDuePaise / 100).toFixed(2) : '')
  const [upi, setUpi] = useState<Upi | null>(null)
  const [utr, setUtr] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function receiptToast(receiptNumber: string) {
    toast.show({ title: 'Payment recorded', description: `Receipt ${receiptNumber}`, tone: 'success' })
    onClose()
  }

  async function take() {
    setError(null)
    const paise = parseRupeesToPaise(amount)
    if (paise === null || paise < MIN_PAISE || paise > MAX_PAISE) { setError('Enter an amount between ₹1 and ₹1,00,000.'); return }
    setSubmitting(true)
    const r = await takeDoorPayment(visit.id, { mode, amountPaise: paise })
    setSubmitting(false)
    if (!r.ok) { setError(r.error); return }
    if ('receiptNumber' in r.data) receiptToast(r.data.receiptNumber)
    else setUpi(r.data)
  }

  async function confirm() {
    if (!upi) return
    setError(null)
    if (!UTR_PATTERN.test(normaliseUtr(utr))) { setError('Enter the UTR shown in the payer\'s UPI app (usually 12 digits).'); return }
    setSubmitting(true)
    const r = await confirmDoorUpi(visit.id, { requestId: upi.requestId, utr: utr.trim() })
    setSubmitting(false)
    if (!r.ok) { setError(r.error); return }
    receiptToast(r.data.receiptNumber)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Collect payment: {visit.patientName}</DialogTitle>
        </DialogHeader>
        {upi === null ? (
          <form id={`${id}-form`} className="space-y-3" onSubmit={(e) => { e.preventDefault(); void take() }}>
            <p className="text-sm">
              Due for this visit: <span className="font-medium">{formatPaise(visit.amountDuePaise)}</span>
              {visit.unpricedTests > 0 && <span className="block text-xs text-muted-foreground">{visit.unpricedTests} {visit.unpricedTests === 1 ? 'test has' : 'tests have'} no price yet.</span>}
            </p>
            <fieldset className="flex gap-4">
              <legend className="mb-1 text-sm font-medium">Paid by</legend>
              {(['cash', 'upi'] as const).map((m) => (
                <label key={m} className="flex min-h-11 items-center gap-2 text-base">
                  <input type="radio" name={`${id}-mode`} value={m} checked={mode === m} onChange={() => setMode(m)} />
                  {m === 'cash' ? 'Cash' : 'UPI'}
                </label>
              ))}
            </fieldset>
            <div>
              <label htmlFor={`${id}-amount`} className="block text-sm font-medium">Amount (₹)</label>
              <input id={`${id}-amount`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoComplete="off" className={`${FIELD} min-h-11 text-base`} />
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- a server-rendered data: URL QR */}
            <img src={upi.qrDataUrl} alt={`UPI QR code for ${formatPaise(upi.amountPaise)}`} width={200} height={200} className="mx-auto h-50 w-50 rounded bg-white p-1" />
            <p className="text-sm text-muted-foreground">Ask the patient to scan and pay {formatPaise(upi.amountPaise)}, then enter the UTR from their UPI app.</p>
            <div>
              <label htmlFor={`${id}-utr`} className="block text-sm font-medium">UTR (UPI reference)</label>
              <input id={`${id}-utr`} value={utr} onChange={(e) => setUtr(e.target.value)} maxLength={40} inputMode="numeric" autoComplete="off" className={`${FIELD} min-h-11 font-mono text-base`} />
            </div>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" className={TAP} onClick={onClose}>Close</Button>
          {upi === null
            ? <Button type="submit" form={`${id}-form`} className={TAP} disabled={submitting}>{submitting ? 'Saving…' : mode === 'cash' ? 'Record cash' : 'Show UPI QR'}</Button>
            : <Button type="button" className={TAP} disabled={submitting} onClick={() => void confirm()}>{submitting ? 'Saving…' : 'Confirm UPI payment'}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
