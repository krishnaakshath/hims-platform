'use client'
// Claims an encounter for the signed-in coder (POST status `{ action: 'claim' }`), then refreshes the
// server-rendered list. A refusal (e.g. 409 "already claimed", the retry message) is shown inline.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { postCodingAction } from './codingApi'

export function ClaimButton({ encounterId, patientName }: { encounterId: number; patientName: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function claim() {
    setBusy(true)
    setError(null)
    const r = await postCodingAction(encounterId, { action: 'claim' })
    setBusy(false)
    if (r.ok) { router.refresh(); return }
    setError(r.error)
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button type="button" size="sm" variant="outline" onClick={claim} disabled={busy} aria-label={`Claim (${patientName})`}>
        {busy ? 'Claiming…' : 'Claim'}
      </Button>
      {error && <p role="alert" className="max-w-48 text-xs text-destructive">{error}</p>}
    </div>
  )
}
