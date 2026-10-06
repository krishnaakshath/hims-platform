'use client'
import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

export function StartTelemedicineButton({ appointmentId }: { appointmentId: number }) {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<{ id: number; joinLink: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  async function start() {
    setStarting(true)
    setError(null)
    const res = await fetch(`/api/appointments/${appointmentId}/telemedicine`, { method: 'POST' })
    setStarting(false)

    if (res.status === 409) {
      const body = await res.json().catch(() => null)
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
      setError(body?.error ?? 'A telemedicine session already exists for this appointment.')
      return
    }
    if (!res.ok) {
      setError('Could not start the telemedicine visit. Please try again.')
      return
    }

    const { id, patientJoinToken } = await res.json()
    // Spec §1: "the actual send action is left to staff copying the link" --
    // this component doesn't wire any SMS/email delivery. It shows the
    // patient's join link as copyable text for staff to send however they
    // already do, plus a link straight to the provider's own call screen
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

  return (
    <div className="flex flex-col items-start gap-1">
      <Button type="button" size="sm" variant="outline" onClick={start} disabled={starting}>
        {starting ? 'Starting…' : 'Start telemedicine visit'}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
