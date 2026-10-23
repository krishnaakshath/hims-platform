'use client'
// WS7 T9 (spec D15): the reviewer's queue of portal self-service submissions. A policy is
// approved against an insurer (and optional TPA) from the payer master; an ABHA is approved as
// typed (recorded, not verified with ABDM); either may be rejected with a reason the patient sees.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { sendJson } from '@/lib/client-fetch'
import { formatIstDateTime } from '@/lib/india-time'
import { INPUT_CLASS } from '@/components/registration/Field'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/toast'

export interface PortalSubmissionQueueRow {
  id: number; kind: 'policy' | 'abha'; patientName: string; uhid: string | null; submittedAt: string
  details: { label: string; value: string }[]; hasCard: boolean; cardHref: string | null
  /** WS7 T16: where this reviewer opens the patient's policies after approving (null = no link). */
  policyHref?: string | null
}
export interface PayerOption { payerId: number; name: string }

const REASON_MIN = 5
const REASON_MAX = 300

function Row({ row, insurers, tpas }: { row: PortalSubmissionQueueRow; insurers: PayerOption[]; tpas: PayerOption[] }) {
  const router = useRouter()
  const toast = useToast()
  const [insurerId, setInsurerId] = useState('')
  const [tpaId, setTpaId] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reasonOk = reason.trim().length >= REASON_MIN && reason.trim().length <= REASON_MAX
  const canApprove = row.kind === 'abha' || insurerId !== ''

  async function send(body: { decision: 'approve' | 'reject' } & Record<string, unknown>) {
    setBusy(true); setError(null)
    const r = await sendJson(`/api/front-desk/portal-submissions/${row.id}/decision`, 'POST', body)
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    router.refresh()
    // WS7 T16: an approved policy's next step is the patient's policies.
    if (body.decision === 'approve' && row.kind === 'policy') {
      toast.show({ title: 'Policy added', ...(row.policyHref ? { action: { label: 'Open policy', href: row.policyHref } } : {}) })
    } else {
      toast.show({ title: body.decision === 'approve' ? 'ABHA recorded' : 'Submission rejected' })
    }
  }

  const approve = () => send(row.kind === 'policy'
    ? { decision: 'approve', insurerPayerId: Number(insurerId), ...(tpaId ? { tpaPayerId: Number(tpaId) } : {}) }
    : { decision: 'approve' })

  return (
    <li className="rounded-lg border border-border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">
          {row.kind === 'policy' ? 'Insurance policy' : 'ABHA'} · {row.patientName}{row.uhid ? ` (UHID ${row.uhid})` : ''}
        </p>
        <span className="text-xs text-muted-foreground">Submitted {formatIstDateTime(row.submittedAt)}</span>
      </div>
      <dl className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {row.details.map((d) => (
          <div key={d.label}>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{d.label}</dt>
            <dd className="break-words text-sm text-foreground">{d.value}</dd>
          </div>
        ))}
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Card image</dt>
          <dd className="text-sm text-foreground">
            {!row.hasCard ? 'None attached' : row.cardHref ? <a className="text-primary underline" href={row.cardHref} target="_blank" rel="noreferrer">Open card</a> : 'Attached'}
          </dd>
        </div>
      </dl>
      {row.kind === 'policy' && (
        <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="text-xs text-muted-foreground">Insurer (payer master)
            <select aria-label="Insurer" className={INPUT_CLASS} value={insurerId} onChange={(e) => setInsurerId(e.target.value)} disabled={busy}>
              <option value="">Choose the insurer</option>
              {insurers.map((p) => <option key={p.payerId} value={p.payerId}>{p.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted-foreground">TPA (optional)
            <select aria-label="TPA" className={INPUT_CLASS} value={tpaId} onChange={(e) => setTpaId(e.target.value)} disabled={busy}>
              <option value="">No TPA</option>
              {tpas.map((p) => <option key={p.payerId} value={p.payerId}>{p.name}</option>)}
            </select>
          </label>
        </div>
      )}
      {row.kind === 'abha' && <p className="mb-3 text-xs text-muted-foreground">Approving records this ABHA on the chart as &ldquo;Recorded, not verified with ABDM&rdquo;.</p>}
      {rejecting && (
        <label className="mb-3 block text-xs text-muted-foreground">Reason shown to the patient ({REASON_MIN} to {REASON_MAX} characters)
          <textarea aria-label="Reason" className={INPUT_CLASS} rows={2} maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
        </label>
      )}
      {error && <p role="alert" className="mb-2 text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {!rejecting ? (
          <>
            <Button size="sm" onClick={approve} disabled={busy || !canApprove}>Approve</Button>
            <Button size="sm" variant="outline" onClick={() => setRejecting(true)} disabled={busy}>Reject</Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="destructive" onClick={() => send({ decision: 'reject', reason: reason.trim() })} disabled={busy || !reasonOk}>Reject with reason</Button>
            <Button size="sm" variant="outline" onClick={() => { setRejecting(false); setReason('') }} disabled={busy}>Cancel</Button>
          </>
        )}
      </div>
    </li>
  )
}

export function PortalSubmissionQueue({ rows, insurers, tpas }: { rows: PortalSubmissionQueueRow[]; insurers: PayerOption[]; tpas: PayerOption[] }) {
  if (rows.length === 0) return <EmptyState title="No portal submissions are waiting for review." description="Policies and ABHA numbers patients add from the portal appear here." />
  return <ul className="space-y-3">{rows.map((r) => <Row key={r.id} row={r} insurers={insurers} tpas={tpas} />)}</ul>
}
