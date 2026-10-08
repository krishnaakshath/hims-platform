'use client'
import { useEffect, useRef, useState } from 'react'
import { fetchJson, sendJson } from '@/lib/client-fetch'

// SP8: NHCX coverage eligibility for one policy. Posts the check, then polls
// its state every 5 s for up to 2 minutes. Never a simulated answer: with no
// NHCX connection the button is disabled; a payer not on NHCX is sent to the
// insurer portal.

export type EligibilityPanelState = { status: 'pending' | 'eligible' | 'not_eligible' | 'error' | 'no_response'; isMock: boolean }
const POLL_MS = 5_000
const MAX_POLL_MS = 120_000
const PASS = { passThrough: [409, 422, 503] as const }

const RESULT: Record<string, { text: string; className: string }> = {
  eligible: { text: 'Policy in force', className: 'text-emerald-700' },
  not_eligible: { text: 'Policy not in force', className: 'text-red-700' },
  error: { text: 'The insurer returned an error', className: 'text-red-700' },
  no_response: { text: 'Waiting for the insurer; check again later', className: 'text-muted-foreground' },
}

export function EligibilityCheckPanel({ policyId, context, purpose = 'validation', providers, defaultProviderId, nhcxConfigured, payerOnNhcx }: {
  policyId: number
  context: 'registration' | 'admission' | 'preauth' | 'manual'
  purpose?: 'validation' | 'benefits' | 'auth-requirements' | 'discovery'
  providers: { id: number; name: string }[]
  defaultProviderId: number | null
  nhcxConfigured: boolean
  payerOnNhcx: boolean
}) {
  const [providerId, setProviderId] = useState<number | null>(defaultProviderId)
  const [state, setState] = useState<EligibilityPanelState | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  if (!nhcxConfigured) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <button type="button" disabled className="rounded-md border border-border px-2 py-1 opacity-50">Check eligibility (NHCX)</button>
        <span className="text-muted-foreground">NHCX not configured</span>
      </div>
    )
  }
  if (!payerOnNhcx) return <p className="text-xs text-muted-foreground">This insurer is not on NHCX; confirm cover through the insurer portal</p>

  function poll(checkId: number, started: number) {
    timer.current = setTimeout(async () => {
      const r = await fetchJson<EligibilityPanelState>(`/api/nhcx/eligibility/${checkId}`)
      if (r.ok && r.data) {
        setState(r.data)
        if (r.data.status !== 'pending') { setWaiting(false); return }
      }
      if (Date.now() - started >= MAX_POLL_MS) { setWaiting(false); setState({ status: 'no_response', isMock: r.ok && r.data ? r.data.isMock : false }); return }
      poll(checkId, started)
    }, POLL_MS)
  }

  async function run() {
    if (!providerId) { setError('Choose the treating doctor'); return }
    setError(null); setState(null); setWaiting(true)
    const r = await sendJson<{ checkId: number }>('/api/nhcx/eligibility', 'POST', { policyId, purpose, context, providerId }, PASS)
    if (!r.ok) { setWaiting(false); setError(r.error); return }
    poll(r.data.checkId, Date.now())
  }

  const result = state && state.status !== 'pending' ? RESULT[state.status] : null
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <select aria-label="Treating doctor" value={providerId ?? ''} onChange={(e) => setProviderId(e.target.value ? Number(e.target.value) : null)} className="rounded-md border border-border px-2 py-1">
        <option value="">Treating doctor</option>
        {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <button type="button" disabled={waiting} onClick={run} className="rounded-md border border-border px-2 py-1 hover:bg-secondary disabled:opacity-50">Check eligibility (NHCX)</button>
      {waiting && <span className="text-muted-foreground">Asking the insurer…</span>}
      {result && <span className={`font-semibold ${result.className}`}>{result.text}</span>}
      {state?.isMock && <span className="font-semibold text-amber-800">Sandbox mock - not real</span>}
      {error && <span role="alert" className="text-destructive">{error}</span>}
    </div>
  )
}
