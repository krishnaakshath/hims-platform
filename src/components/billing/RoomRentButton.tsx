'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { BedDouble } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { sendJson } from '@/components/tariff/api'
import { formatIsoDate } from '@/lib/india-time'

type Skip = { date: string; reason: 'no_rate' | 'no_room' }

/** SP4: post room rent for every ended census day of an admission (idempotent). */
export function RoomRentButton({ admissionId }: { admissionId: number }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ posted: number; skipped: Skip[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function post() {
    setBusy(true); setError(null)
    const res = await sendJson<{ posted: number; skipped: Skip[] }>(`/api/billing/admissions/${admissionId}/room-rent`, 'POST', {})
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setResult(res.data)
    router.refresh()
  }

  return (
    <div className="space-y-1">
      <Button type="button" variant="outline" disabled={busy} onClick={() => void post()}>
        <BedDouble className="mr-1 h-4 w-4" aria-hidden="true" /> {busy ? 'Posting…' : 'Post room rent to date'}
      </Button>
      {result && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {result.posted === 0 ? 'No new days to post.' : `Posted ${result.posted} day${result.posted > 1 ? 's' : ''}.`}
          {result.skipped.length > 0 && ` Skipped: ${result.skipped.map((s) => `${formatIsoDate(s.date)} (${s.reason === 'no_rate' ? 'no rate for that room' : 'no bed recorded'})`).join(', ')}.`}
        </p>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
