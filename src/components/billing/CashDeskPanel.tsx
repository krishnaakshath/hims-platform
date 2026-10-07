'use client'
import { useId, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FIELD_CLASS, sendJson } from '@/components/tariff/api'
import { formatPaise, parseRupeesToPaise } from '@/lib/format'
import { PAYMENT_MODES, paymentReferenceProblem, type PaymentMode } from '@/lib/billing/validation'
import { PAYMENT_MODE_LABELS } from './labels'

type Tab = 'advance' | 'payment' | 'refund'
const TAB_LABEL: Record<Tab, string> = { advance: 'Take advance', payment: 'Take payment', refund: 'Refund' }
const BUTTON_LABEL: Record<Tab, string> = { advance: 'Record advance', payment: 'Record payment', refund: 'Issue refund' }

/**
 * SP4 cash desk: take an advance or a payment (front desk included), or refund (billing authority
 * only, `canRefund`). Record-keeping only: no money moves through the app. A reference that looks
 * like a card number is refused inline before anything is sent.
 */
export function CashDeskPanel({ patientId, admissionId, finalisedInvoices, canRefund }: {
  patientId: string
  admissionId: number | null
  finalisedInvoices: { id: number; invoiceNumber: string; totalPaise: number }[]
  canRefund: boolean
}) {
  const router = useRouter()
  const uid = useId()
  const id = (k: string) => `${uid}-${k}`
  const tabs: Tab[] = canRefund ? ['advance', 'payment', 'refund'] : ['advance', 'payment']
  const [tab, setTab] = useState<Tab>('advance')
  const [mode, setMode] = useState<PaymentMode>('cash')
  const [reference, setReference] = useState('')
  const [amount, setAmount] = useState('')
  const [invoiceId, setInvoiceId] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ kind: 'receipt'; number: string; paymentId: number } | { kind: 'refund'; number: string } | null>(null)

  const amountPaise = amount.trim() === '' ? null : parseRupeesToPaise(amount)
  const amountProblem = amount.trim() !== '' && (amountPaise === null || amountPaise <= 0) ? 'Enter an amount in rupees, e.g. 2,500 or 2,500.50' : null
  const referenceProblem = mode !== 'cash' || reference.trim() !== '' ? paymentReferenceProblem(mode, reference) : null
  const reasonMissing = tab === 'refund' && reason.trim().length < 5
  const blocked = busy || amountPaise === null || amountPaise <= 0 || referenceProblem !== null || reasonMissing

  function switchTab(t: Tab) {
    setTab(t); setError(null); setDone(null); setInvoiceId(''); setReason(''); setMode('cash'); setReference('')
  }

  async function submit() {
    if (blocked || amountPaise === null) return
    setBusy(true); setError(null); setDone(null)
    const ref = reference.trim() ? { reference: reference.trim() } : {}
    if (tab === 'refund') {
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
        <div>
          <label htmlFor={id('ref')} className="mb-1 block text-xs font-medium text-muted-foreground">Reference</label>
          <input id={id('ref')} value={reference} maxLength={40} onChange={(e) => setReference(e.target.value)} className={FIELD_CLASS}
            placeholder={mode === 'cash' ? 'Optional for cash' : 'UTR, cheque or transaction number'} aria-invalid={referenceProblem ? true : undefined} />
          {referenceProblem && <p className="mt-1 text-xs text-destructive">{referenceProblem}</p>}
        </div>
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
          <Button type="submit" disabled={blocked}>{BUTTON_LABEL[tab]}</Button>
        </div>
      </form>
    </div>
  )
}
