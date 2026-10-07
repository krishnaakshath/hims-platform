'use client'
// Coding queries to the treating doctors: raise a query (the encounter moves to "Query open"), read
// the thread of responses, reply, and close or withdraw. Question and reply text are shown as plain
// text. Read-only (no controls) when !canManage, e.g. once coding is finalised.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { CodingQueryStatus } from '@/lib/coding/status'
import { Button } from '@/components/ui/button'
import { closeCodingQuery, raiseCodingQuery, replyToCodingQuery, type CodingApiResult } from './codingApi'

export interface QueryView {
  id: number
  status: CodingQueryStatus
  question: string
  addressedToName: string
  raisedByName: string
  raisedLabel: string
  responses: { id: number; authorName: string; authorRoleLabel: string; body: string; createdLabel: string }[]
}

const QUERY_STATUS_LABEL: Record<CodingQueryStatus, string> = { open: 'Open', answered: 'Answered', closed: 'Closed', withdrawn: 'Withdrawn' }
const fieldClass = 'rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm'

function ReplyForm({ query, busy, onSend }: { query: QueryView; busy: boolean; onSend: (body: string) => Promise<boolean> }) {
  const [body, setBody] = useState('')
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={async (e) => { e.preventDefault(); if (await onSend(body.trim())) setBody('') }}
    >
      <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
        Reply
        <textarea rows={2} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} className={fieldClass} aria-label={`Reply to the query to ${query.addressedToName}`} />
      </label>
      <Button type="submit" size="sm" variant="outline" disabled={busy || body.trim() === ''}>Send reply</Button>
    </form>
  )
}

export function CodingQueriesPanel({ encounterId, queries, providers, defaultProviderId, canRaise, canManage }: {
  encounterId: number
  queries: QueryView[]
  /** Active doctors (id and name only). */
  providers: { id: number; name: string }[]
  defaultProviderId: number | null
  canRaise: boolean
  canManage: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [raising, setRaising] = useState(false)
  const [providerId, setProviderId] = useState(defaultProviderId !== null && providers.some((p) => p.id === defaultProviderId) ? String(defaultProviderId) : '')
  const [question, setQuestion] = useState('')

  async function act(fn: () => Promise<CodingApiResult<unknown>>): Promise<boolean> {
    setBusy(true)
    setError(null)
    const r = await fn()
    setBusy(false)
    if (!r.ok) { setError(r.error); return false }
    router.refresh()
    return true
  }

  async function raise(e: React.FormEvent) {
    e.preventDefault()
    const ok = await act(() => raiseCodingQuery(encounterId, { addressedToProviderId: Number(providerId), question: question.trim() }))
    if (ok) { setRaising(false); setQuestion('') }
  }

  return (
    <section aria-labelledby="coding-queries" className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="coding-queries" className="text-base font-semibold">Queries to doctors</h2>
        {canRaise && !raising && <Button type="button" size="sm" variant="outline" onClick={() => setRaising(true)}>Raise query</Button>}
      </div>

      {canRaise && raising && (
        <form onSubmit={raise} className="space-y-2 rounded-lg border border-dashed border-border p-3" aria-label="Raise a query to a doctor">
          <label className="flex flex-col gap-1 text-xs font-medium">
            Doctor
            <select required value={providerId} onChange={(e) => setProviderId(e.target.value)} className={`${fieldClass} h-8 py-0`}>
              <option value="">Choose a doctor</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Question
            <textarea required rows={3} maxLength={1000} value={question} onChange={(e) => setQuestion(e.target.value)} className={fieldClass} />
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !providerId || question.trim() === ''}>Send query</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setRaising(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {queries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No queries raised for this visit.</p>
      ) : (
        <ul className="space-y-3">
          {queries.map((q) => {
            const live = q.status === 'open' || q.status === 'answered'
            return (
              <li key={q.id} className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded-full border border-border px-2 py-0.5 font-medium text-foreground">{QUERY_STATUS_LABEL[q.status]}</span>
                  <span>{`${q.raisedByName} to ${q.addressedToName} · ${q.raisedLabel}`}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm">{q.question}</p>
                {q.responses.length > 0 && (
                  <ol className="space-y-1.5 border-l-2 border-border ps-3" aria-label="Responses">
                    {q.responses.map((r) => (
                      <li key={r.id} className="text-sm">
                        <p className="text-xs text-muted-foreground">{`${r.authorName} (${r.authorRoleLabel}) · ${r.createdLabel}`}</p>
                        <p className="whitespace-pre-wrap">{r.body}</p>
                      </li>
                    ))}
                  </ol>
                )}
                {canManage && live && (
                  <div className="space-y-2">
                    <ReplyForm query={q} busy={busy} onSend={(body) => act(() => replyToCodingQuery(q.id, body))} />
                    <div className="flex gap-2">
                      <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => act(() => closeCodingQuery(q.id, 'close'))} aria-label={`Close the query to ${q.addressedToName}`}>Close</Button>
                      {q.status === 'open' && (
                        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => act(() => closeCodingQuery(q.id, 'withdraw'))} aria-label={`Withdraw the query to ${q.addressedToName}`}>Withdraw</Button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
