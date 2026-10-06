export interface MessageRow {
  id: number
  senderRole: 'provider' | 'patient' | 'system'
  senderName: string
  body: string
  createdAt: string | Date
  // Staff-to-staff note (e.g. pharmacy confirming with the prescriber) --
  // the patient-facing query/API paths never return a row with this true,
  // so it only ever renders in a staff-side thread view.
  internal?: boolean
}

/**
 * Shared by both the doctor-side inbox and the patient portal's Messages
 * tab -- `viewerRole` decides which side of the thread reads as "you"
 * (right-aligned) vs. the other party (left-aligned), the only thing that
 * differs between the two contexts. A `'system'` message (an automated
 * notice, e.g. eligibility-confirmation) belongs to neither side on either
 * surface, so it's rendered as a centered banner before that left/right
 * comparison is ever made.
 */
export function MessageThreadView({ messages, viewerRole }: { messages: MessageRow[]; viewerRole: 'provider' | 'patient' }) {
  if (messages.length === 0) {
    return <p className="text-sm text-muted-foreground">No messages yet. Send the first one below.</p>
  }
  return (
    <div className="space-y-3">
      {messages.map((m) => {
        if (m.senderRole === 'system') {
          return (
            <div key={m.id} role="status" className="rounded-lg border border-border bg-secondary px-3 py-2 text-center text-sm text-foreground">
              <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">AUTOMATED NOTICE</p>
              <p className="whitespace-pre-wrap">{m.body}</p>
              <p className="italic text-muted-foreground">This is an automated note, not a reply from your care team.</p>
              <p className="mt-1 text-[10px] text-muted-foreground">{new Date(m.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>
            </div>
          )
        }
        const isOwn = m.senderRole === viewerRole
        return (
          <div key={m.id} className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${isOwn ? 'ml-auto bg-primary/10 text-foreground' : 'bg-secondary text-foreground'}`}>
            <p className="mb-0.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {m.senderName}
              {m.internal && (
                <span className="rounded-full border border-warning/30 bg-warning/10 px-1.5 py-0 text-[9px] font-semibold normal-case tracking-normal text-warning">Internal — not visible to patient</span>
              )}
            </p>
            <p className="whitespace-pre-wrap">{m.body}</p>
            <p className="mt-1 text-[10px] text-muted-foreground">{new Date(m.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>
          </div>
        )
      })}
    </div>
  )
}
