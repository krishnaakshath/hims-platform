'use client'
import { useState } from 'react'

interface Patient { id: string; name: string }

export function VirtualCardPaymentForm({
  patients,
  initialPatientId,
  initialAmountCents,
}: {
  patients: Patient[]
  initialPatientId?: string
  initialAmountCents?: number
}) {
  const [patientId, setPatientId] = useState(initialPatientId ?? patients[0]?.id ?? '')
  const [amount, setAmount] = useState(initialAmountCents ? (initialAmountCents / 100).toFixed(2) : '')
  const [cardNumber, setCardNumber] = useState('')
  const [expMonth, setExpMonth] = useState('')
  const [expYear, setExpYear] = useState('')
  const [cvc, setCvc] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [outcome, setOutcome] = useState<{ result: 'success' | 'failed'; cardLast4: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    setOutcome(null)
    const res = await fetch('/api/mock-payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId,
        chargeId: null,
        amountCents: Math.round(Number(amount) * 100),
        cardNumber,
        expMonth: Number(expMonth),
        expYear: Number(expYear),
        cvc,
      }),
    })
    setSubmitting(false)
    if (res.ok) {
      const body = await res.json()
      setOutcome({ result: body.result, cardLast4: body.cardLast4 })
    } else {
      const body = await res.json()
      setError(body.error ?? 'Could not record this demo payment.')
    }
  }

  return (
    <div>
      <div className="mb-6 rounded-lg border-2 border-accent bg-accent/10 p-4">
        <p className="text-sm font-bold uppercase tracking-wide text-foreground">Demo payment — no real transaction is processed.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          This form never contacts a real payment processor and never stores a full card number or CVC. The outcome
          below is decided only by a fake checksum on the card number you type in.
        </p>
      </div>

      {outcome ? (
        <div className={`rounded-lg border p-4 ${outcome.result === 'success' ? 'border-primary bg-secondary' : 'border-destructive bg-destructive/10'}`}>
          <p className="text-sm font-semibold text-foreground">
            {outcome.result === 'success' ? 'Demo payment recorded as successful.' : 'Demo payment recorded as failed.'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Card ending in {outcome.cardLast4}. No real transaction occurred.</p>
          <button type="button" onClick={() => setOutcome(null)} className="mt-3 text-xs font-medium text-primary hover:underline">
            Record another demo payment
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {error && <p className="text-sm font-medium text-destructive">{error}</p>}

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Patient</label>
            <select value={patientId} onChange={(e) => setPatientId(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm">
              {patients.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Payment Amount</label>
            <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Card Number</label>
            <input
              type="text"
              inputMode="numeric"
              placeholder="4242 4242 4242 4242"
              value={cardNumber}
              onChange={(e) => setCardNumber(e.target.value)}
              className="w-full rounded-md border border-border px-2 py-1.5 text-sm"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Expiration Month</label>
              <input type="number" min="1" max="12" placeholder="MM" value={expMonth} onChange={(e) => setExpMonth(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Expiration Year</label>
              <input type="number" min="2024" max="2099" placeholder="YYYY" value={expYear} onChange={(e) => setExpYear(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">CVC</label>
              <input type="text" inputMode="numeric" maxLength={4} value={cvc} onChange={(e) => setCvc(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
            </div>
          </div>

          <button
            type="button"
            onClick={submit}
            disabled={submitting || !patientId || !amount || !cardNumber || !expMonth || !expYear || !cvc}
            className="w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Processing demo payment...' : 'Process Demo Transaction'}
          </button>
        </div>
      )}
    </div>
  )
}
