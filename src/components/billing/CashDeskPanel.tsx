'use client'
import { useId, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FIELD_CLASS, sendJson } from '@/components/tariff/api'
import { formatPaise, parseRupeesToPaise } from '@/lib/format'
import { PAYMENT_MODES, paymentReferenceProblem, type PaymentMode } from '@/lib/billing/validation'
import { UTR_PATTERN, normaliseUtr } from '@/lib/payments/provider'
import { PAYMENT_MODE_LABELS } from './labels'

type Tab = 'advance' | 'payment' | 'refund'
const TAB_LABEL: Record<Tab, string> = { advance: 'Take advance', payment: 'Take payment', refund: 'Refund' }
const BUTTON_LABEL: Record<Tab, string> = { advance: 'Record advance', payment: 'Record payment', refund: 'Issue refund' }

/** 250050 -> '2500.50' for the rupee input (integer arithmetic, no floats). */
function paiseToRupeesInput(paise: number): string {
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`
}

type UpiRequest = { requestId: number; qrDataUrl: string; vpa: string; payeeName: string; amountPaise: number }

/**
 * SP4 cash desk: take an advance or a payment (front desk included), or refund (billing authority
 * only, `canRefund`). Record-keeping only: no money moves through the app. A reference that looks
 * like a card number is refused inline before anything is sent.
 *
 * Foundations T11: every mode posts the same receipt. With the hospital UPI id set (`upiReady`),
 * UPI on an advance or payment shows a server-rendered QR for the amount; the payment is recorded
 * when the payer's UTR is entered. Opened from "Collect payment", the payment tab is prefilled.
 */
export function CashDeskPanel({ patientId, admissionId, finalisedInvoices, canRefund, upiReady = false, initialAmountPaise, initialInvoiceId }: {
  patientId: string
  admissionId: number | null
  finalisedInvoices: { id: number; invoiceNumber: string; totalPaise: number }[]
  canRefund: boolean
  upiReady?: boolean
  initialAmountPaise?: number
  initialInvoiceId?: number
}) {
  const router = useRouter()
  const uid = useId()
  const id = (k: string) => `${uid}-${k}`
  const tabs: Tab[] = canRefund ? ['advance', 'payment', 'refund'] : ['advance', 'payment']
  const prefilled = initialAmountPaise !== undefined && initialAmountPaise > 0
  const [tab, setTab] = useState<Tab>(prefilled ? 'payment' : 'advance')
  const [mode, setModeRaw] = useState<PaymentMode>('cash')
  const [reference, setReference] = useState('')
  const [amount, setAmountRaw] = useState(prefilled ? paiseToRupeesInput(initialAmountPaise) : '')
  const [invoiceId, setInvoiceIdRaw] = useState(prefilled && initialInvoiceId !== undefined && finalisedInvoices.some((i) => i.id === initialInvoiceId) ? String(initialInvoiceId) : '')
  const [upi, setUpi] = useState<UpiRequest | null>(null)
  const [utr, setUtr] = useState('')
  // A shown QR is for one amount and invoice: changing either (or the mode) starts over.
  const setAmount = (v: string) => { setAmountRaw(v); setUpi(null); setUtr('') }
  const setMode = (v: PaymentMode) => { setModeRaw(v); setUpi(null); setUtr(''); setError(null) }
  const setInvoiceId = (v: string) => { setInvoiceIdRaw(v); setUpi(null); setUtr('') }
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ kind: 'receipt'; number: string; paymentId: number } | { kind: 'refund'; number: string } | null>(null)

  const amountPaise = amount.trim() === '' ? null : parseRupeesToPaise(amount)
  const amountProblem = amount.trim() !== '' && (amountPaise === null || amountPaise <= 0) ? 'Enter an amount in rupees, e.g. 2,500 or 2,500.50' : null
  const qrFlow = upiReady && mode === 'upi' && tab !== 'refund'
  const referenceProblem = !qrFlow && (mode !== 'cash' || reference.trim() !== '') ? paymentReferenceProblem(mode, reference) : null
  const utrProblem = utr.trim() !== '' && !UTR_PATTERN.test(normaliseUtr(utr)) ? 'Enter the UTR shown in the payer\'s UPI app (usually 12 digits)' : null
  const reasonMissing = tab === 'refund' && reason.trim().length < 5
  const blocked = busy || amountPaise === null || amountPaise <= 0 || referenceProblem !== null || reasonMissing
    || (qrFlow && (upi === null || utr.trim() === '' || utrProblem !== null))

  function switchTab(t: Tab) {
    setTab(t); setError(null); setDone(null); setInvoiceId(''); setReason(''); setMode('cash'); setReference('')
  }

  async function showQr() {
    if (busy || amountPaise === null || amountPaise <= 0) return
    setBusy(true); setError(null); setDone(null)
    const res = await sendJson<UpiRequest>('/api/billing/payments/upi-request', 'POST', {
      patientId, amountPaise, kind: tab === 'advance' ? 'advance' : 'receipt',
      ...(tab === 'advance' && admissionId !== null ? { admissionId } : {}),
      ...(tab === 'payment' && invoiceId ? { invoiceId: Number(invoiceId) } : {}),
    })
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setUpi(res.data)
  }

  async function cancelQr() {
    if (!upi || busy) return
    setBusy(true); setError(null)
    const res = await sendJson(`/api/billing/payments/upi-request/${upi.requestId}/cancel`, 'POST', {})
    setBusy(false)
    // A request that is already confirmed or expired cannot be cancelled; say so and keep the panel.
    if (!res.ok && res.status !== 409) { setError(res.error); return }
    setUpi(null); setUtr('')
  }

  async function submit() {
    if (blocked || amountPaise === null) return
    setBusy(true); setError(null); setDone(null)
    const ref = reference.trim() ? { reference: reference.trim() } : {}
    if (qrFlow && upi) {
      const res = await sendJson<{ receiptNumber: string; paymentId: number }>(`/api/billing/payments/upi-request/${upi.requestId}/confirm`, 'POST', { utr: utr.trim() })
      setBusy(false)
      if (!res.ok) { setError(res.error); return }
      setDone({ kind: 'receipt', number: res.data.receiptNumber, paymentId: res.data.paymentId })
    } else if (tab === 'refund') {
      const res = await sendJson<{ refundNumber: string }>('/api/billing/refunds', 'POST', {
        patientId, mode, ...ref, amountPaise, reason: reason.trim(), ...(admissionId !== null ? { admissionId } : {}),
      })
      setBusy(false)
      if (!res.ok) { setError(res.error); return }
      setDone({ kind: 'refund', number: res.data.refundNumber })
    } else {
      const res = await sendJson<{ receiptNumber: string; paymentId: number }>('/api/billing/payments', 'POST', {
        patientId, kind: tab === 'advance' ? 'advance' : 'receipt', mode, ...ref, amountPaise,
        ...(tab === 'advance' && admissionId !== null ? { admissionId } : {}),
        ...(tab === 'payment' && invoiceId ? { invoiceId: Number(invoiceId) } : {}),
      })
      setBusy(false)
      if (!res.ok) { setError(res.error); return }
      setDone({ kind: 'receipt', number: res.data.receiptNumber, paymentId: res.data.paymentId })
    }
    setAmount(''); setReference(''); setReason(''); setInvoiceId('')
    router.refresh()
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div role="tablist" aria-label="Cash desk action" className="mb-4 flex gap-1 rounded-md bg-muted p-1">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => switchTab(t)}
            className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors ${tab === t ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      <form role="tabpanel" aria-label={TAB_LABEL[tab]} className="space-y-3" noValidate onSubmit={(e) => { e.preventDefault(); void submit() }}>
        {tab === 'advance' && (
          <p className="text-xs text-muted-foreground">{admissionId !== null ? 'Counted as a deposit for the current admission.' : 'Held as credit on the patient account.'}</p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={id('amount')} className="mb-1 block text-xs font-medium text-muted-foreground">Amount (₹)</label>
            <input id={id('amount')} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={FIELD_CLASS}
              aria-invalid={amountProblem ? true : undefined} />
            {amountProblem && <p className="mt-1 text-xs text-destructive">{amountProblem}</p>}
            {amountPaise !== null && amountPaise > 0 && <p className="mt-1 text-xs text-muted-foreground">{formatPaise(amountPaise)}</p>}
          </div>
          <div>
            <label htmlFor={id('mode')} className="mb-1 block text-xs font-medium text-muted-foreground">Mode</label>
            <select id={id('mode')} value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)} className={FIELD_CLASS}>
              {PAYMENT_MODES.map((m) => <option key={m} value={m}>{PAYMENT_MODE_LABELS[m]}</option>)}
            </select>
          </div>
        </div>
        {!qrFlow && (
          <div>
            <label htmlFor={id('ref')} className="mb-1 block text-xs font-medium text-muted-foreground">Reference</label>
            <input id={id('ref')} value={reference} maxLength={40} onChange={(e) => setReference(e.target.value)} className={FIELD_CLASS}
              placeholder={mode === 'cash' ? 'Optional for cash' : mode === 'card' ? 'Card machine approval or reference number' : 'UTR, cheque or transaction number'}
              aria-invalid={referenceProblem ? true : undefined} />
            {referenceProblem && <p className="mt-1 text-xs text-destructive">{referenceProblem}</p>}
          </div>
        )}
        {tab === 'payment' && (
          <div>
            <label htmlFor={id('inv')} className="mb-1 block text-xs font-medium text-muted-foreground">Against invoice</label>
            <select id={id('inv')} value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} className={FIELD_CLASS}>
              <option value="">On account (no specific invoice)</option>
              {finalisedInvoices.map((i) => <option key={i.id} value={i.id}>{i.invoiceNumber} · {formatPaise(i.totalPaise)}</option>)}
            </select>
          </div>
        )}
        {tab === 'refund' && (
          <div>
            <label htmlFor={id('reason')} className="mb-1 block text-xs font-medium text-muted-foreground">Reason</label>
            <input id={id('reason')} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} className={FIELD_CLASS} />
          </div>
        )}
        {qrFlow && upi && (
          <div className="rounded-md border border-border bg-background p-3">
            <div className="flex flex-wrap items-center gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- a server-rendered data URL, not a remote image */}
              <img src={upi.qrDataUrl} alt={`UPI QR code for ${formatPaise(upi.amountPaise)}`} width={160} height={160} className="h-40 w-40 rounded bg-white p-1" />
              <dl className="space-y-1 text-sm">
                <div><dt className="text-xs text-muted-foreground">Amount</dt><dd className="text-lg font-semibold tabular-nums">{formatPaise(upi.amountPaise)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">UPI id</dt><dd className="font-mono">{upi.vpa}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Payee</dt><dd>{upi.payeeName}</dd></div>
              </dl>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Ask the patient to scan and pay, then enter the UTR from their UPI app.</p>
            <div className="mt-2">
              <label htmlFor={id('utr')} className="mb-1 block text-xs font-medium text-muted-foreground">UTR (UPI reference)</label>
              <input id={id('utr')} value={utr} maxLength={40} inputMode="numeric" autoComplete="off" onChange={(e) => setUtr(e.target.value)} className={FIELD_CLASS}
                aria-invalid={utrProblem ? true : undefined} />
              {utrProblem && <p className="mt-1 text-xs text-destructive">{utrProblem}</p>}
            </div>
          </div>
        )}
        {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
        {done?.kind === 'receipt' && (
          <p className="text-sm text-emerald-700 dark:text-emerald-300" aria-live="polite">
            Recorded.{' '}
            <Link href={`/print/receipts/${done.paymentId}`} className="inline-flex items-center gap-1 font-medium underline">
              <Printer className="h-3.5 w-3.5" aria-hidden="true" />Print receipt {done.number}
            </Link>
          </p>
        )}
        {done?.kind === 'refund' && <p className="text-sm text-emerald-700 dark:text-emerald-300" aria-live="polite">Refund {done.number} issued.</p>}
        <div className="flex justify-end">
          {qrFlow && !upi
            ? <Button type="button" disabled={busy || amountPaise === null || amountPaise <= 0} onClick={() => void showQr()}>Show UPI QR</Button>
            : (
              <span className="flex gap-2">
                {qrFlow && upi && <Button type="button" variant="outline" disabled={busy} onClick={() => void cancelQr()}>Cancel QR</Button>}
                <Button type="submit" disabled={blocked}>{qrFlow ? 'Record payment' : BUTTON_LABEL[tab]}</Button>
              </span>
            )}
        </div>
      </form>
    </div>
  )
}
