'use client'
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Siren } from 'lucide-react'
import { BrandLogo } from '@/components/BrandLogo'

interface QueueDisplayRow {
  ticketNumber: number
  urgency: 'routine' | 'urgent' | 'emergency'
  stage: 'waiting' | 'ready'
}

const PIN_STORAGE_KEY = 'queueDisplayPin'
const POLL_INTERVAL_MS = 8000

// Small label + icon alongside color -- never color alone, matching
// AssignmentStatusChip.tsx's convention -- so an urgent/emergency ticket
// reads correctly for a colorblind viewer across a waiting room.
function UrgencyBadge({ urgency }: { urgency: QueueDisplayRow['urgency'] }) {
  if (urgency === 'routine') return null
  const isEmergency = urgency === 'emergency'
  const Icon = isEmergency ? Siren : AlertTriangle
  return (
    <span className={`inline-flex items-center gap-2 text-xl font-bold uppercase tracking-wide ${isEmergency ? 'text-destructive' : 'text-warning'}`}>
      <Icon className="h-6 w-6" aria-hidden="true" />
      {urgency}
    </span>
  )
}

function TicketCard({ ticket }: { ticket: QueueDisplayRow }) {
  return (
    <div className="flex items-center justify-between rounded-2xl border-2 border-border bg-card px-8 py-6 shadow-sm">
      <span className="text-7xl font-black tabular-nums text-foreground">{ticket.ticketNumber}</span>
      <UrgencyBadge urgency={ticket.urgency} />
    </div>
  )
}

function QueueSection({ title, tickets }: { title: string; tickets: QueueDisplayRow[] }) {
  return (
    <div className="flex-1">
      <h2 className="mb-4 text-3xl font-bold text-foreground">{title}</h2>
      {tickets.length === 0 ? (
        <p className="text-xl text-muted-foreground">No tickets</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Keyed on stage+ticketNumber+index, not ticketNumber alone --
              a duplicate ticket number (the DEFAULT-0 sentinel, or a
              genuine same-day race per the plan's Scope decision #5) would
              otherwise collide as a React key. */}
          {tickets.map((t, i) => <TicketCard key={`${t.stage}-${t.ticketNumber}-${i}`} ticket={t} />)}
        </div>
      )}
    </div>
  )
}

function PinEntryForm({ onSubmit, error }: { onSubmit: (pin: string) => void; error: string | null }) {
  const [pin, setPin] = useState('')
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4">
      <BrandLogo className="text-2xl font-semibold tracking-tight text-foreground" />
      <form
        onSubmit={(e) => { e.preventDefault(); if (pin) onSubmit(pin) }}
        className="w-full max-w-sm space-y-4 rounded-2xl border border-border bg-card p-8 shadow-sm"
      >
        <h1 className="text-center text-xl font-semibold text-foreground">Enter Display PIN</h1>
        <input
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="PIN"
          aria-label="Display PIN"
          autoFocus
          className="w-full rounded-md border border-border px-4 py-3 text-center text-lg"
        />
        {error && <p className="text-center text-sm text-destructive">{error}</p>}
        <button
          type="submit"
          disabled={!pin}
          className="w-full rounded-md bg-primary px-4 py-3 text-lg font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          View Queue
        </button>
      </form>
    </div>
  )
}

export default function QueueDisplayPage() {
  const [pin, setPin] = useState<string | null>(null)
  const [tickets, setTickets] = useState<QueueDisplayRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [initialized, setInitialized] = useState(false)
  // Mirrors `pin` for use inside setInterval's closure without re-creating
  // the interval on every render.
  const pinRef = useRef<string | null>(null)

  async function fetchTickets(candidatePin: string) {
    // A network blip (offline TV, DNS hiccup, etc.) must not surface as an
    // unhandled promise rejection -- fall back to the same "Retrying…"
    // state the !res.ok branch below already uses; the next poll heals it.
    try {
      const res = await fetch('/api/queue-display', { headers: { 'x-queue-display-pin': candidatePin } })
      if (res.status === 401) {
        // Never silently retry a bad/changed PIN in a loop -- clear it and
        // fall back to the entry form with an explanation.
        sessionStorage.removeItem(PIN_STORAGE_KEY)
        pinRef.current = null
        setPin(null)
        setTickets(null)
        setError('Incorrect PIN. Please try again.')
        return
      }
      if (!res.ok) {
        setError('Could not load the queue. Retrying…')
        return
      }
      const body = await res.json()
      setTickets(body.tickets)
      setError(null)
    } catch {
      setError('Could not load the queue. Retrying…')
    }
  }

  // On mount: read any stored PIN and attempt an immediate fetch.
  // sessionStorage is a browser-only external system with no server-side
  // equivalent, so this can't be computed during render (would crash on the
  // server) or via a lazy useState initializer (client's first render would
  // then diverge from the server-rendered HTML, causing a hydration
  // mismatch) -- a one-time read-on-mount effect is the correct escape
  // hatch here, not the derived-state anti-pattern this lint rule targets.
  useEffect(() => {
    let storedPin: string | null = null
    try {
      storedPin = sessionStorage.getItem(PIN_STORAGE_KEY)
    } catch {
      storedPin = null
    }
    if (storedPin) {
      pinRef.current = storedPin
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see comment above
      setPin(storedPin)
      fetchTickets(storedPin)
    }
    setInitialized(true)
  }, [])

  // Poll once authenticated (pin set and accepted), cleaned up on unmount
  // or when the pin changes (e.g. cleared after a 401). Deliberately omits
  // fetchTickets from the dep array -- it's redefined every render but is
  // read through pinRef inside the interval callback, not called directly
  // here, so re-running this effect on every render (recreating the
  // interval) isn't needed.
  useEffect(() => {
    if (!pin) return
    pinRef.current = pin
    const id = setInterval(() => {
      if (pinRef.current) fetchTickets(pinRef.current)
    }, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [pin])

  function handlePinSubmit(enteredPin: string) {
    try {
      sessionStorage.setItem(PIN_STORAGE_KEY, enteredPin)
    } catch {
      // sessionStorage unavailable (e.g. blocked) -- still proceed with the
      // in-memory pin for this page load.
    }
    setError(null)
    pinRef.current = enteredPin
    setPin(enteredPin)
    fetchTickets(enteredPin)
  }

  if (!initialized) return null

  if (!pin) {
    return <PinEntryForm onSubmit={handlePinSubmit} error={error} />
  }

  if (tickets === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-xl text-muted-foreground">Loading queue…</p>
      </div>
    )
  }

  const waiting = tickets.filter((t) => t.stage === 'waiting')
  const ready = tickets.filter((t) => t.stage === 'ready')

  return (
    <div className="min-h-screen bg-background px-10 py-8">
      <div className="mb-8 flex items-center justify-between">
        <BrandLogo className="text-xl font-semibold tracking-tight text-foreground" />
        <h1 className="text-2xl font-bold text-foreground">Queue Status</h1>
      </div>
      {error && <p className="mb-4 text-center text-sm text-destructive">{error}</p>}
      <div className="flex flex-col gap-10 lg:flex-row">
        <QueueSection title="Waiting" tickets={waiting} />
        <QueueSection title="Ready" tickets={ready} />
      </div>
    </div>
  )
}
