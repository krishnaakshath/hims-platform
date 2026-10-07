'use client'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatPaise, parseRupeesToPaise } from '@/lib/money'
import { rateRevisionSchema } from '@/lib/tariff/validation'
import { addDays } from '@/lib/tariff/versions'
import { FIELD_CLASS, formatIsoDate, sendJson } from './api'

export interface ReviseTarget { id: number; amountPaise: number; validFrom: string; validTo: string | null }

export const AMOUNT_HELP = 'Enter a valid amount in rupees, for example 1,250.50'

/** Revising closes the current version the day before the new one starts, in one server transaction. */
export function ReviseRateModal({ rate, today, onClose }: { rate: ReviseTarget; today: string; onClose: () => void }) {
  const router = useRouter()
  const uid = useId()
  const [amount, setAmount] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState(today > rate.validFrom ? today : addDays(rate.validFrom, 1))
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const newPaise = parseRupeesToPaise(amount)
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)

  async function submit() {
    setError(null)
    if (newPaise === null) { setError(AMOUNT_HELP); return }
    const parsed = rateRevisionSchema.safeParse({ amountPaise: newPaise, effectiveFrom })
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the amount and date'); return }
    setSubmitting(true)
    const res = await sendJson(`/api/tariff/rates/${rate.id}/revise`, 'POST', parsed.data)
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    setError(res.error)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Revise rate</DialogTitle></DialogHeader>
        <form className="space-y-3" noValidate onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <p className="text-sm text-muted-foreground">Current rate is {formatPaise(rate.amountPaise)} from {formatIsoDate(rate.validFrom)}. The new rate replaces it from the date below; history is kept.</p>
          <div>
            <label htmlFor={`${uid}-amt`} className="mb-1 block text-xs font-medium text-muted-foreground">New amount (₹)</label>
            <input id={`${uid}-amt`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoComplete="off" className={FIELD_CLASS} />
          </div>
          <div>
            <label htmlFor={`${uid}-from`} className="mb-1 block text-xs font-medium text-muted-foreground">Effective from</label>
            <input id={`${uid}-from`} type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className={FIELD_CLASS} />
          </div>
          {newPaise !== null && dateOk && (
            <p className="rounded-md bg-muted p-3 text-sm" aria-live="polite">
              {`Current ${formatPaise(rate.amountPaise)} until ${formatIsoDate(addDays(effectiveFrom, -1))}, new ${formatPaise(newPaise)} from ${formatIsoDate(effectiveFrom)}`}
            </p>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={submitting}>Confirm revision</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
