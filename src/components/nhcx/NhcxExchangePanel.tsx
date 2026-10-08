'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'
import { formatIstDateTime } from '@/lib/india-time'
import { NhcxResponseReview } from './NhcxResponseReview'

// SP8: the NHCX exchanges of a claim or a pre-auth. Responses waiting for a
// person are reviewed here (ruling 6). No payload or JWE reaches this view.

export type ExchangeRow = {
  id: number; entityType: string; action: string; direction: 'outbound' | 'inbound'; state: string; protocolStatus: string | null; correlationPrefix: string
  attempts: number; lastErrorCode: string | null; createdAt: string; respondedAt: string | null; reviewState: string; isMock: boolean
}

export function NhcxExchangePanel({ exchanges, canAct, sendPreauthId, canSendPreauth, sendReason }: {
  exchanges: ExchangeRow[]
  canAct: boolean
  sendPreauthId?: number
  canSendPreauth?: boolean
  sendReason?: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function post(url: string, done: string) {
    setBusy(true); setMessage(null)
    const r = await sendJson<{ result?: string }>(url, 'POST', {}, { passThrough: [409, 422, 429, 503] })
    setBusy(false)
    setMessage(r.ok ? done : r.error)
    if (r.ok) router.refresh()
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4 text-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">NHCX</h2>
        {sendPreauthId !== undefined && canAct && (
          <span className="flex items-center gap-2 text-xs">
            <button type="button" disabled={!canSendPreauth || busy} onClick={() => post(`/api/rcm/preauths/${sendPreauthId}/nhcx`, 'Queued for NHCX')} className="rounded-md border border-border px-2 py-1 hover:bg-secondary disabled:opacity-50">Send via NHCX</button>
            {!canSendPreauth && sendReason && <span className="text-muted-foreground">{sendReason}</span>}
          </span>
        )}
      </div>
      {message && <p role="status" className="mb-2 text-xs">{message}</p>}
      {exchanges.length === 0 ? <p className="text-muted-foreground">No NHCX messages yet.</p> : (
        <table className="w-full text-xs">
          <thead><tr className="text-left text-muted-foreground"><th className="py-1">Message</th><th>Direction</th><th>State</th><th>Attempts</th><th>Error</th><th>Created</th><th>Answered</th><th /></tr></thead>
          <tbody>
            {exchanges.map((x) => (
              <tr key={x.id} className="border-t border-border align-top">
                <td className="py-1">{x.action}{x.isMock && <span className="ml-1 font-semibold text-amber-800">Sandbox mock - not real</span>}</td>
                <td>{x.direction}</td>
                <td>{x.state}{x.reviewState === 'pending' ? ' · to review' : x.reviewState !== 'not_needed' ? ` · ${x.reviewState}` : ''}</td>
                <td>{x.attempts}</td>
                <td className="font-mono">{x.lastErrorCode ?? ''}</td>
                <td>{formatIstDateTime(x.createdAt)}</td>
                <td>{x.respondedAt ? formatIstDateTime(x.respondedAt) : ''}</td>
                <td className="space-x-1 text-right">
                  {canAct && x.direction === 'inbound' && x.reviewState === 'pending' && (
                    <button type="button" className="rounded-md border border-border px-2 py-0.5" onClick={() => setOpen(open === x.id ? null : x.id)}>Review</button>
                  )}
                  {canAct && x.direction === 'outbound' && ['sent', 'queued', 'dispatched'].includes(x.state) && (
                    <button type="button" disabled={busy} className="rounded-md border border-border px-2 py-0.5" onClick={() => post(`/api/rcm/nhcx/exchanges/${x.id}/status`, 'Status requested')}>Check status</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open !== null && <div className="mt-3"><NhcxResponseReview exchangeId={open} onDone={() => setOpen(null)} /></div>}
    </section>
  )
}
