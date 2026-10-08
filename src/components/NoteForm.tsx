'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { LocalDateTime } from '@/components/LocalDateTime'

function safeIso(value: string): string {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toISOString()
}

export interface NoteRecord {
  id: number
  noteType: 'progress' | 'nursing' | 'intake'
  authorName: string
  authorRole: string
  subjective: string | null
  objective: string | null
  assessment: string | null
  plan: string | null
  status: 'draft' | 'signed'
  createdAt: string
  signedAt: string | null
}

// Same dot + plain-text-label convention as StatusChip/AssignmentStatusChip/
// AppointmentStatusChip, but kept local rather than a new shared component:
// those all key off a domain-specific status union already owned elsewhere
// (StatusChip is hardwired to the rule engine's Verdict), and note status
// doesn't belong to any of them.
function NoteStatusPill({ status }: { status: 'draft' | 'signed' }) {
  const config = status === 'signed'
    ? { label: 'Signed', dotClassName: 'bg-success', textClassName: 'text-success' }
    : { label: 'Draft', dotClassName: 'bg-warning', textClassName: 'text-warning' }
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${config.textClassName}`}>
      <span className={`h-2 w-2 rounded-full ${config.dotClassName}`} aria-hidden="true" />
      {config.label}
    </span>
  )
}

const NOTE_TYPE_LABEL: Record<NoteRecord['noteType'], string> = {
  progress: 'Progress',
  nursing: 'Nursing',
  intake: 'Intake',
}

export function NoteForm({ patientId, canWrite }: { patientId: string; canWrite: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [noteType, setNoteType] = useState<NoteRecord['noteType']>('progress')
  const [subjective, setSubjective] = useState('')
  const [objective, setObjective] = useState('')
  const [assessment, setAssessment] = useState('')
  const [plan, setPlan] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canWrite) return null

  function reset() {
    setNoteType('progress')
    setSubjective('')
    setObjective('')
    setAssessment('')
    setPlan('')
    setError(null)
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await sendJson(`/api/patients/${patientId}/notes`, 'POST', {
      noteType,
      ...(subjective ? { subjective } : {}),
      ...(objective ? { objective } : {}),
      ...(assessment ? { assessment } : {}),
      ...(plan ? { plan } : {}),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); setOpen(false); reset(); return }
    setError(res.error)
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>New Note</Button>
      {open && (
        <Dialog open onOpenChange={(o) => { if (!o) { setOpen(false); reset() } }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>New Note</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <select value={noteType} onChange={(e) => setNoteType(e.target.value as NoteRecord['noteType'])} aria-label="Note type" className="w-full rounded-md border border-border px-3 py-2 text-sm">
                <option value="progress">Progress</option>
                <option value="nursing">Nursing</option>
                <option value="intake">Intake</option>
              </select>
              <textarea value={subjective} onChange={(e) => setSubjective(e.target.value)} placeholder="Subjective" aria-label="Subjective" className="w-full rounded-md border border-border px-3 py-2 text-sm" rows={2} />
              <textarea value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Objective" aria-label="Objective" className="w-full rounded-md border border-border px-3 py-2 text-sm" rows={2} />
              <textarea value={assessment} onChange={(e) => setAssessment(e.target.value)} placeholder="Assessment" aria-label="Assessment" className="w-full rounded-md border border-border px-3 py-2 text-sm" rows={2} />
              <textarea value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="Plan" aria-label="Plan" className="w-full rounded-md border border-border px-3 py-2 text-sm" rows={2} />
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setOpen(false); reset() }}>Cancel</Button>
              <Button onClick={submit} disabled={submitting}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

export function NoteCard({ note, patientId, canSign }: { note: NoteRecord; patientId: string; canSign: boolean }) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function sign() {
    setSubmitting(true)
    setError(null)
    const res = await sendJson(`/api/patients/${patientId}/notes/${note.id}/sign`, 'PUT')
    setSubmitting(false)
    if (res.ok) { router.refresh(); return }
    setError(res.error)
  }

  return (
    <div className="rounded-lg border border-border bg-secondary/30 px-4 py-3 text-sm">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="font-medium text-foreground">
          {NOTE_TYPE_LABEL[note.noteType]} note <span className="font-normal text-muted-foreground">by {note.authorName}</span>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <NoteStatusPill status={note.status} />
          {canSign && note.status === 'draft' && (
            <Button size="xs" variant="outline" onClick={sign} disabled={submitting}>Sign</Button>
          )}
        </div>
      </div>
      <p className="mb-1.5 text-xs text-muted-foreground"><LocalDateTime iso={safeIso(note.createdAt)} /></p>
      {error && <p role="alert" className="mb-1.5 text-xs text-destructive">{error}</p>}
      <dl className="space-y-1 text-xs text-foreground">
        {note.subjective && <div><dt className="inline font-semibold text-muted-foreground">Subjective: </dt><dd className="inline">{note.subjective}</dd></div>}
        {note.objective && <div><dt className="inline font-semibold text-muted-foreground">Objective: </dt><dd className="inline">{note.objective}</dd></div>}
        {note.assessment && <div><dt className="inline font-semibold text-muted-foreground">Assessment: </dt><dd className="inline">{note.assessment}</dd></div>}
        {note.plan && <div><dt className="inline font-semibold text-muted-foreground">Plan: </dt><dd className="inline">{note.plan}</dd></div>}
      </dl>
    </div>
  )
}
