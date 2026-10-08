'use client'
import { useState } from 'react'
import { sendJson } from '@/lib/client-fetch'

// Runs a gateway token fetch for ABDM or NHCX and shows a fixed message.
export function IntegrationTestButton({ capability, label }: { capability: 'abdm' | 'nhcx'; label: string }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  async function run() {
    setBusy(true); setResult(null)
    const r = await sendJson<{ ok: boolean; mock?: boolean; expiresInSeconds?: number; message?: string }>('/api/settings/integrations/test', 'POST', { capability }, { passThrough: [429, 503] })
    setBusy(false)
    if (!r.ok) { setResult(r.error); return }
    setResult(r.data.ok ? (r.data.mock ? 'Sandbox mock - not real: no connection was made' : `Connected (token valid for ${r.data.expiresInSeconds ?? 0} s)`) : (r.data.message ?? 'Not connected'))
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <button type="button" disabled={busy} onClick={run} className="rounded-md border border-border px-3 py-1.5 hover:bg-secondary disabled:opacity-50">{label}</button>
      {result && <span role="status" className="text-xs">{result}</span>}
    </div>
  )
}
