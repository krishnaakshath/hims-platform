'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Send, Info } from 'lucide-react'

interface Candidate { formSubmissionId: number; patientId: string; patientName: string; templateName: string; completedDate: Date | null }

export function SendSurveyButton({ candidates }: { candidates: Candidate[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<number | null>(candidates[0]?.formSubmissionId ?? null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // `candidates` shrinks after a successful send (router.refresh()), so a
  // `selected` id from before that refresh can point at a patient no longer
  // in the list -- re-sync whenever the candidate set changes instead of
  // only initializing once at mount.
  useEffect(() => {
    if (!candidates.some((c) => c.formSubmissionId === selected)) {
      setSelected(candidates[0]?.formSubmissionId ?? null)
    }
  }, [candidates, selected])

  async function send() {
    if (selected === null) return
    setSending(true)
    setError(null)
    const res = await fetch('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formSubmissionId: selected }),
    })
    setSending(false)
    if (res.ok) {
      setOpen(false)
      router.refresh()
    } else {
      const body = await res.json()
      setError(body.error ?? 'Could not send survey.')
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90"
      >
        <Send className="h-4 w-4" aria-hidden="true" />
        Send Survey
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-primary/10 bg-card/95 p-4 shadow-lg backdrop-blur-sm">
          {candidates.length === 0 ? (
            <div className="flex gap-2 rounded-md border border-primary/15 bg-primary/5 p-3 text-sm text-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <p>No completed intakes are eligible for a survey right now — every completed intake already has one sent.</p>
            </div>
          ) : (
            <>
              <label htmlFor="survey-candidate" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</label>
              <select
                id="survey-candidate"
                value={selected ?? ''}
                onChange={(e) => setSelected(Number(e.target.value))}
                className="mb-3 w-full rounded-md border border-border bg-card px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {candidates.map((c) => <option key={c.formSubmissionId} value={c.formSubmissionId}>{c.patientName} — {c.templateName}</option>)}
              </select>
              {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
              <button onClick={send} disabled={sending} className="w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
                {sending ? 'Sending…' : 'Send'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
