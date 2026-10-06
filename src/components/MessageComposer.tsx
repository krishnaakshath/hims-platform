'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Send } from 'lucide-react'

/**
 * Posts to /api/messages/[patientId] -- works from either the doctor-side
 * inbox (a staff session) or the patient portal (a patient session acting
 * on their own thread). `viewerRole` tells the route which of the two a
 * browser holding BOTH cookies at once (e.g. staff testing the patient
 * portal in the same browser) should act as here -- the route still fully
 * re-validates that a real, matching session exists before honoring it,
 * this is only a disambiguation hint, never a trust decision by itself.
 * See src/app/api/messages/[patientId]/route.ts.
 */
export function MessageComposer({ patientId, viewerRole }: { patientId: string; viewerRole: 'provider' | 'patient' }) {
  const router = useRouter()
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send() {
    if (!body.trim()) return
    setSending(true)
    setError(null)
    const res = await fetch(`/api/messages/${patientId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, actingAs: viewerRole }),
    })
    setSending(false)
    if (res.ok) {
      setBody('')
      router.refresh()
    } else {
      const data = await res.json()
      setError(data.error ?? 'Could not send this message.')
    }
  }

  return (
    <div>
      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
      <div className="flex items-end gap-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          rows={2}
          placeholder="Write a message…"
          className="flex-1 rounded-md border border-border px-3 py-2 text-sm"
        />
        <button
          onClick={send}
          disabled={sending || !body.trim()}
          className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          Send
        </button>
      </div>
    </div>
  )
}
