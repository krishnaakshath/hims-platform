'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { EncounterStatus } from '@/lib/encounters/status'
import { useSelectWorkspaceTab } from './WorkspaceShell'

type Warning = 'no_vitals' | 'unsigned_notes'
const WARNING_TEXT: Record<Warning, string> = {
  no_vitals: 'No vitals were recorded for this visit.',
  unsigned_notes: 'A note from this visit is still unsigned.',
}
const REASON_MIN = 5
const REASON_MAX = 300

function errorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const code = (body as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

// WS1 T5 (spec ruling 4): the workspace's sticky footer. "Complete visit" POSTs to the complete
// route; an OPD visit with no diagnosis opens "No diagnosis recorded" (jump to the Diagnosis tab,
// or give a reason). After completion the warnings are shown, with a "Sign note" jump to Notes.
export function CompleteVisitBar({ encounterId, status, canComplete }: { encounterId: number; status: EncounterStatus; canComplete: boolean }) {
  const router = useRouter()
  const selectTab = useSelectWorkspaceTab()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  const [done, setDone] = useState<{ warnings: Warning[] } | null>(null)

  async function complete(noDiagnosisReason?: string) {
    setSubmitting(true)
    setError(null)
    const res = await sendJson<{ warnings: Warning[] }>(`/api/encounters/${encounterId}/complete`, 'POST', noDiagnosisReason === undefined ? {} : { noDiagnosisReason })
    setSubmitting(false)
    if (res.ok) {
      setAsking(false)
      setDone({ warnings: res.data.warnings ?? [] })
      router.refresh()
      return
    }
    if (res.status === 409 && errorCode(res.body) === 'diagnosis_missing') { setAsking(true); return }
    setError(res.error)
  }

  const trimmed = reason.trim()

  return (
    <div className="flex flex-col gap-2">
      {done ? (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-semibold text-success">Visit completed.</span>
          {done.warnings.map((w) => <span key={w} className="text-warning-foreground">{WARNING_TEXT[w]}</span>)}
          {done.warnings.includes('unsigned_notes') && (
            <Button size="sm" variant="outline" onClick={() => selectTab('notes')}>Sign note</Button>
          )}
        </div>
      ) : status === 'completed' ? (
        <p className="text-sm text-muted-foreground">Visit completed.</p>
      ) : canComplete ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Finished with this patient? Completing closes the visit to further changes.</p>
          <Button onClick={() => void complete()} disabled={submitting}>Complete visit</Button>
        </div>
      ) : null}
      {error && !asking && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {asking && (
        <Dialog open onOpenChange={(open) => { if (!open) { setAsking(false); setError(null) } }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>No diagnosis recorded</DialogTitle>
              <DialogDescription>Add a diagnosis for this visit, or say why there is none.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <label htmlFor="no-diagnosis-reason" className="block text-xs font-medium text-muted-foreground">Reason for no diagnosis</label>
              <textarea
                id="no-diagnosis-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={REASON_MAX}
                rows={3}
                placeholder="e.g. Review visit, results awaited"
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">{REASON_MIN} to {REASON_MAX} characters. Stored on the visit record.</p>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setAsking(false); setError(null); selectTab('diagnosis') }}>Add diagnosis</Button>
              <Button onClick={() => void complete(trimmed)} disabled={submitting || trimmed.length < REASON_MIN}>Complete without diagnosis</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
