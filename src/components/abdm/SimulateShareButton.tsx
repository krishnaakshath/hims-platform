'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { sendJson } from '@/lib/client-fetch'
import { SANDBOX_MOCK_LABEL } from './AbhaVerifyDialog'
import { Field, INPUT_CLASS } from '@/components/registration/Field'

// WS12 T6: rendered only when ABDM is in mock mode. Adds a pending, labelled
// mock share so the match and mismatch paths can be tried without a signed
// ABDM callback.
export function SimulateShareButton() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [likePatientId, setLikePatientId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<number | null>(null)

  async function simulate() {
    setBusy(true); setError(null); setDone(null)
    const body: Record<string, string> = { counterId: 'DESK-1' }
    if (likePatientId.trim()) body.likePatientId = likePatientId.trim()
    if (name.trim()) body.name = name.trim()
    const r = await sendJson<{ shareId: number; tokenNumber: number }>('/api/abdm/shares/simulate', 'POST', body)
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setDone(r.data.tokenNumber)
    router.refresh()
  }

  return (
    <div className="mb-4 rounded-md border border-border bg-muted/40 p-3">
      <p className="mb-2 text-sm font-medium">Simulate ABHA share <span className="ml-1 text-xs font-normal text-muted-foreground">{SANDBOX_MOCK_LABEL}</span></p>
      <div className="mb-2 grid gap-2 sm:grid-cols-2">
        <Field label="Copy from patient id (optional)">
          {(f) => <input {...f} className={INPUT_CLASS} value={likePatientId} onChange={(e) => setLikePatientId(e.target.value)} maxLength={40} />}
        </Field>
        <Field label="Name">
          {(f) => <input {...f} className={INPUT_CLASS} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Sandbox Mock Patient" />}
        </Field>
      </div>
      <Button type="button" size="sm" disabled={busy} onClick={simulate}>Simulate ABHA share</Button>
      {done != null && <span className="ml-3 text-sm">Token {done} added to the queue.</span>}
      {error && <span role="alert" className="ml-3 text-sm text-red-600">{error}</span>}
    </div>
  )
}
