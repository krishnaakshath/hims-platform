'use client'
import { useState } from 'react'
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { sendJson } from '@/lib/client-fetch'
import { QueueDisplayPinForm } from '@/components/QueueDisplayPinForm'

// WS6 T10: the lobby display's settings card -- status, a one-time generated
// PIN, a preview link, and the custom-PIN form for admins who prefer their own.
export function QueueDisplayCard({ isAdmin, configured }: { isAdmin: boolean; configured: boolean }) {
  const [pinSet, setPinSet] = useState(configured)
  const [generatedPin, setGeneratedPin] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function generate() {
    setGenerating(true)
    setError(null)
    const res = await sendJson<{ pin: string }>('/api/settings/queue-display-pin/generate', 'POST', {})
    setGenerating(false)
    if (!res.ok) { setError(res.error); return }
    setGeneratedPin(res.data.pin)
    setPinSet(true)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Lobby queue display</h2>
          <p className="text-xs text-muted-foreground">Token numbers, doctor and room on a waiting-room screen. Never patient names or UHIDs.</p>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${pinSet ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground'}`}>
          {pinSet ? 'PIN set' : 'Not set up'}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {isAdmin && (
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {generating ? 'Generating…' : pinSet ? 'Generate new PIN' : 'Generate PIN'}
          </button>
        )}
        {pinSet && (
          <Link
            href="/display/queue?lang=en"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary"
          >
            Open preview
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

      {generatedPin && (
        <div className="rounded-md border border-border bg-secondary/40 px-4 py-3">
          <p className="text-xs text-muted-foreground">New display PIN. It is shown only once; enter it on the lobby screen now.</p>
          <p className="mt-1 font-mono text-2xl font-bold tracking-widest text-foreground">{generatedPin}</p>
        </div>
      )}

      <div className="border-t border-border pt-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Custom PIN</h3>
        <QueueDisplayPinForm isAdmin={isAdmin} configured={pinSet} onSaved={() => { setPinSet(true); setGeneratedPin(null) }} />
      </div>
    </div>
  )
}
