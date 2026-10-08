'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import { formatPaise, parseRupeesToPaise } from '@/lib/format'

// SP8 (ruling 6): an NHCX response is applied by a person. This shows what the
// insurer sent and offers the matching SP7 action PRE-FILLED but not
// submitted; after the SP7 action succeeds, the review is confirmed. Dismiss
// needs a reason.

type Summary = { outcome: string | null; submittedPaise: number | null; benefitPaise: number | null; paymentAmountPaise: number | null; paymentDate: string | null } | null
export type PayloadViewData = {
  exchangeId: number; action: string; reviewState: string; claimId: number | null; preauthId: number | null; summary: Summary
  dispositionText: string | null; preAuthRef: string | null; queryText: string | null; paymentAmountPaise: number | null; paymentDate: string | null; isMock: boolean
}

const rupees = (p: number | null | undefined) => (p == null ? '' : (p / 100).toFixed(2))
const input = 'w-full rounded-md border border-border px-2 py-1 text-sm'
const PASS = { passThrough: [409, 422] as const }

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-xs"><span className="mb-0.5 block font-medium">{label}</span>{children}</label>
}

export function NhcxResponseReview({ exchangeId, onDone }: { exchangeId: number; onDone: () => void }) {
  const router = useRouter()
  const [view, setView] = useState<PayloadViewData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }))

  useEffect(() => {
    let live = true
    fetchJson<PayloadViewData>(`/api/rcm/nhcx/exchanges/${exchangeId}/payload`).then((r) => {
      if (!live) return
      if (!r.ok) { setError(r.error); return }
      const v = r.data
      setView(v)
      setF({
        approved: rupees(v.summary?.benefitPaise), decidedOn: '', validUntil: '', approvalReference: v.preAuthRef ?? '',
        question: v.queryText ?? '', raisedOn: '', dueOn: '', utr: '', paymentDate: v.paymentDate ?? '', received: rupees(v.paymentAmountPaise), tds: '0', bank: '0',
      })
    })
    return () => { live = false }
  }, [exchangeId])

  async function review(decision: 'confirmed' | 'dismissed', extra: Record<string, unknown> = {}) {
    const r = await sendJson(`/api/rcm/nhcx/exchanges/${exchangeId}/review`, 'POST', { decision, ...extra }, PASS)
    if (!r.ok) { setError(r.error); return false }
    router.refresh(); onDone()
    return true
  }

  async function apply(url: string, body: unknown, ack = false) {
    setBusy(true); setError(null)
    const r = await sendJson(url, 'POST', body, PASS)
    if (!r.ok) { setBusy(false); setError(r.error); return }
    await review('confirmed', ack ? { sendPaymentAck: true } : {})
    setBusy(false)
  }

  if (error && !view) return <p role="alert" className="text-sm text-destructive">{error}</p>
  if (!view) return <p className="text-sm text-muted-foreground">Opening the response…</p>
  const s = view.summary
  const base = view.claimId ? `/api/rcm/claims/${view.claimId}` : view.preauthId ? `/api/rcm/preauths/${view.preauthId}` : null

  let form: React.ReactNode = null
  if ((view.action === 'claim/on_submit' && view.claimId) || (view.action === 'preauth/on_submit' && view.preauthId)) {
    const isClaim = view.action === 'claim/on_submit'
    form = (
      <form aria-label={isClaim ? 'Record the insurer decision' : 'Record the pre-authorisation approval'} className="space-y-2" onSubmit={(e) => {
        e.preventDefault()
        const approvedPaise = parseRupeesToPaise(f.approved)
        if (approvedPaise === null) { setError('Enter the approved amount'); return }
        void apply(`${base}/actions`, isClaim
          ? { action: 'record_decision', approvedPaise, decidedOn: f.decidedOn, disallowances: [] }
          : { action: 'approve', approvedPaise, approvalReference: f.approvalReference, validUntil: f.validUntil, decidedOn: f.decidedOn })
      }}>
        <div className="grid gap-2 sm:grid-cols-2">
          <Labeled label="Approved (₹)"><input className={input} value={f.approved} onChange={(e) => set('approved', e.target.value)} /></Labeled>
          <Labeled label="Decided on"><input type="date" className={input} value={f.decidedOn} onChange={(e) => set('decidedOn', e.target.value)} /></Labeled>
          {!isClaim && <Labeled label="Approval reference"><input className={input} value={f.approvalReference} onChange={(e) => set('approvalReference', e.target.value)} /></Labeled>}
          {!isClaim && <Labeled label="Valid until"><input type="date" className={input} value={f.validUntil} onChange={(e) => set('validUntil', e.target.value)} /></Labeled>}
        </div>
        <button type="submit" disabled={busy} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">{isClaim ? 'Record decision' : 'Record approval'}</button>
      </form>
    )
  } else if (view.action === 'communication/request' && base) {
    form = (
      <form aria-label="Record the insurer query" className="space-y-2" onSubmit={(e) => { e.preventDefault(); void apply(`${base}/actions`, { action: 'record_query', question: f.question, raisedOn: f.raisedOn, dueOn: f.dueOn }) }}>
        <Labeled label="Query"><textarea className={input} rows={3} value={f.question} onChange={(e) => set('question', e.target.value)} /></Labeled>
        <div className="grid gap-2 sm:grid-cols-2">
          <Labeled label="Raised on"><input type="date" className={input} value={f.raisedOn} onChange={(e) => set('raisedOn', e.target.value)} /></Labeled>
          <Labeled label="Due on"><input type="date" className={input} value={f.dueOn} onChange={(e) => set('dueOn', e.target.value)} /></Labeled>
        </div>
        <button type="submit" disabled={busy} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">Record query</button>
      </form>
    )
  } else if (view.action === 'paymentnotice/request' && view.claimId) {
    form = (
      <form aria-label="Record the settlement" className="space-y-2" onSubmit={(e) => {
        e.preventDefault()
        const receivedPaise = parseRupeesToPaise(f.received); const tdsPaise = parseRupeesToPaise(f.tds); const bankChargesPaise = parseRupeesToPaise(f.bank)
        if (receivedPaise === null || tdsPaise === null || bankChargesPaise === null) { setError('Check the amounts'); return }
        void apply(`/api/rcm/claims/${view.claimId}/settlements`, { utr: f.utr, paymentDate: f.paymentDate, receivedPaise, tdsPaise, bankChargesPaise }, true)
      }}>
        <p className="text-xs text-muted-foreground">Type the UTR from the bank statement after checking the credit.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Labeled label="UTR"><input className={input} value={f.utr} onChange={(e) => set('utr', e.target.value)} /></Labeled>
          <Labeled label="Payment date"><input type="date" className={input} value={f.paymentDate} onChange={(e) => set('paymentDate', e.target.value)} /></Labeled>
          <Labeled label="Received (₹)"><input className={input} value={f.received} onChange={(e) => set('received', e.target.value)} /></Labeled>
          <Labeled label="TDS (₹)"><input className={input} value={f.tds} onChange={(e) => set('tds', e.target.value)} /></Labeled>
          <Labeled label="Bank charges (₹)"><input className={input} value={f.bank} onChange={(e) => set('bank', e.target.value)} /></Labeled>
        </div>
        <button type="submit" disabled={busy} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">Record settlement</button>
      </form>
    )
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
      {view.isMock && <p className="text-xs font-semibold text-amber-800">Sandbox mock - not real</p>}
      <dl className="grid grid-cols-2 gap-1 text-xs">
        <dt className="text-muted-foreground">Outcome</dt><dd>{s?.outcome ?? '—'}</dd>
        {s?.submittedPaise != null && <><dt className="text-muted-foreground">Submitted</dt><dd>{formatPaise(s.submittedPaise)}</dd></>}
        {s?.benefitPaise != null && <><dt className="text-muted-foreground">Approved by insurer</dt><dd>{formatPaise(s.benefitPaise)}</dd></>}
        {view.paymentAmountPaise != null && <><dt className="text-muted-foreground">Payment</dt><dd>{formatPaise(view.paymentAmountPaise)}{view.paymentDate ? ` on ${view.paymentDate}` : ''}</dd></>}
      </dl>
      {view.dispositionText && <p className="text-xs">Insurer note: {view.dispositionText}</p>}
      {form}
      <div className="space-y-1 border-t border-border pt-2">
        <Labeled label="Dismiss with a reason"><input className={input} value={note} onChange={(e) => setNote(e.target.value)} /></Labeled>
        <button type="button" disabled={busy || note.trim().length < 5} onClick={() => void review('dismissed', { note: note.trim() })} className="rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-50">Dismiss</button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
