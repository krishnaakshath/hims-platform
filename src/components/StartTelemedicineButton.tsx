'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import type { TelemedicineSessionStatus } from '@/lib/queries/telemedicine-sessions'

// WS7 T6: `initialSession` is the appointment's existing session as the server
// knows it, so after a reload a live call still offers "Rejoin (session active)"
// instead of a start button that would only 409.
export function StartTelemedicineButton({ appointmentId, initialSession = null }: {
  appointmentId: number
  initialSession?: { sessionId: number; status: TelemedicineSessionStatus } | null
}) {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<{ id: number; joinLink: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  async function start() {
    setStarting(true)
    setError(null)
    const res = await sendJson<{ id: number; patientJoinToken: string }>(`/api/appointments/${appointmentId}/telemedicine`, 'POST')
    setStarting(false)

    if (!res.ok && res.status === 409) {
      const body = res.body as { id?: number; patientJoinToken?: string } | null
      // A 409 means a session already exists for this appointment -- most
      // often because staff refreshed or double-clicked after already
      // creating one. The route now recovers that existing session's
      // id/token (see the create route's comment), so re-render the same
      // copy-link/join-call UI instead of a dead-end error: this makes
      // clicking the button again effectively idempotent.
      if (body?.id != null && body?.patientJoinToken) {
        setSession({ id: body.id, joinLink: `${window.location.origin}/telemedicine/join/${body.patientJoinToken}` })
        return
      }
      setError(res.error)
      return
    }
    if (!res.ok) {
      setError(res.error)
      return
    }

    const { id, patientJoinToken } = res.data
    // Foundations T9: the route notifies the patient through the notification
    // service (generic text, no link). The join link stays visible as a
    // copyable fallback for staff to send if no channel reached the patient, plus a link straight to the provider's own call screen
    // (Step 3) for whenever staff is ready to actually join the call --
    // not an automatic redirect, which would yank staff away from this
    // table before they had a chance to copy the link.
    setSession({ id, joinLink: `${window.location.origin}/telemedicine/join/${patientJoinToken}` })
  }

  async function copyLink() {
    if (!session) return
    setCopyFailed(false)
    try {
      await navigator.clipboard.writeText(session.joinLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // navigator.clipboard.writeText rejects on a non-secure context or a
      // denied permission -- without this catch that's an unhandled promise
      // rejection with no user feedback. The join link is still shown as
      // selectable text in the input below, so staff can still copy it
      // manually.
      setCopyFailed(true)
    }
  }

  if (session) {
    return (
      <div className="flex flex-col items-start gap-1">
        <div className="flex items-center gap-2">
          <input readOnly value={session.joinLink} onFocus={(e) => e.currentTarget.select()} className="w-40 truncate rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground" />
          <Button type="button" size="xs" variant="outline" onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</Button>
          <Link href={`/telemedicine/${session.id}`} className="text-xs font-medium text-primary hover:underline">Join call</Link>
        </div>
        {copyFailed && <p className="text-xs text-destructive">Couldn&apos;t copy automatically — select and copy the link above.</p>}
      </div>
    )
  }

  if (initialSession) {
    if (initialSession.status === 'completed') return <span className="text-xs text-muted-foreground">Video visit ended</span>
    if (initialSession.status === 'failed') return <span className="text-xs text-muted-foreground">Video call failed</span>
    const live = initialSession.status === 'waiting' || initialSession.status === 'in_progress'
    return (
      <div className="flex flex-col items-start gap-1">
        <div className="flex items-center gap-2">
          <Link href={`/telemedicine/${initialSession.sessionId}`} className="text-xs font-medium text-primary hover:underline">
            {live ? 'Rejoin (session active)' : 'Join call'}
          </Link>
          {/* The create route answers an existing session with its join link (409 recovery). */}
          <Button type="button" size="xs" variant="outline" onClick={start} disabled={starting}>
            {starting ? 'Loading…' : 'Patient link'}
          </Button>
        </div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button type="button" size="sm" variant="outline" onClick={start} disabled={starting}>
        {starting ? 'Starting…' : 'Start telemedicine visit'}
      </Button>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
