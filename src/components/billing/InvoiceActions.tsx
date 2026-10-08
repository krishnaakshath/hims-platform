'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { BadgeCheck, FileX2, Printer, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FIELD_CLASS, sendJson } from '@/components/tariff/api'

type Status = 'draft' | 'finalised' | 'cancelled' | 'discarded'
type Pending = 'finalise' | 'discard' | 'cancel' | null

/**
 * SP4: what can be done to an invoice from its detail screen. Finalise and cancel are billing
 * authority actions (`canAuthorise`); every capture role may discard a draft. Print is always offered.
 */
export function InvoiceActions({ invoiceId, status, canAuthorise }: { invoiceId: number; status: Status; canAuthorise: boolean }) {
  const router = useRouter()
  const [pending, setPending] = useState<Pending>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function run(action: Exclude<Pending, null>) {
    setBusy(true); setError(null)
    const res = await sendJson<{ invoiceNumber?: string; creditNoteNumber?: string }>(
      `/api/billing/invoices/${invoiceId}/${action}`, 'POST', action === 'cancel' ? { reason } : {},
    )
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setPending(null); setReason('')
    if (res.data.invoiceNumber) setNotice(`Finalised as ${res.data.invoiceNumber}`)
    if (res.data.creditNoteNumber) setNotice(`Cancelled by credit note ${res.data.creditNoteNumber}`)
    router.refresh()
  }

  const confirmText: Record<Exclude<Pending, null>, { title: string; body: string; button: string }> = {
    finalise: { title: 'Finalise this invoice?', body: 'It gets the next invoice number and can no longer be changed. To correct it later you must cancel it with a credit note.', button: 'Finalise and number' },
    discard: { title: 'Discard this draft?', body: 'Its charges go back to the unbilled list. No number is used.', button: 'Discard draft' },
    cancel: { title: 'Cancel by credit note?', body: 'A credit note for the full value is issued and the charges are freed to be billed again. The invoice keeps its number.', button: 'Issue credit note' },
  }

  return (
    <div className="flex flex-col items-end gap-2 print:hidden">
      <div className="flex flex-wrap justify-end gap-2">
        {status === 'draft' && canAuthorise && (
          <Button type="button" onClick={() => setPending('finalise')}><BadgeCheck className="mr-1 h-4 w-4" aria-hidden="true" />Finalise</Button>
        )}
        {status === 'draft' && (
          <Button type="button" variant="outline" onClick={() => setPending('discard')}><Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />Discard</Button>
        )}
        {status === 'finalised' && canAuthorise && (
          <Button type="button" variant="outline" onClick={() => setPending('cancel')}><FileX2 className="mr-1 h-4 w-4" aria-hidden="true" />Cancel by credit note</Button>
        )}
        <Link href={`/print/invoices/${invoiceId}`} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-sm font-medium hover:bg-muted">
          <Printer className="h-4 w-4" aria-hidden="true" />Print
        </Link>
      </div>
      {status === 'draft' && !canAuthorise && <p className="text-xs text-muted-foreground">Billing or admin staff finalise invoices.</p>}
      {notice && <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300" aria-live="polite">{notice}</p>}
      {error && !pending && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {pending && (
        <Dialog open onOpenChange={(open) => { if (!open) setPending(null) }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>{confirmText[pending].title}</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">{confirmText[pending].body}</p>
            {pending === 'cancel' && (
              <>
                <label htmlFor="cancel-reason" className="text-xs font-medium text-muted-foreground">Reason for the credit note</label>
                <input id="cancel-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} className={FIELD_CLASS} />
              </>
            )}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPending(null)}>Back</Button>
              <Button type="button" variant={pending === 'finalise' ? 'default' : 'destructive'} disabled={busy || (pending === 'cancel' && reason.trim().length < 5)} onClick={() => void run(pending)}>
                {confirmText[pending].button}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
