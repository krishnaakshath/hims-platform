'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { PatientNameOption } from '@/lib/queries/patients'
import type { AdverseEventRow, DrugAccountabilityRow, RegulatoryDocumentRow } from '@/lib/queries/trial-compliance'

// Duplicated from trial-compliance.ts rather than imported as a value --
// that module also exports real DB query functions (getDb, drizzle), and a
// client component importing ANY runtime export from it pulls the whole
// module, pg included, into the browser bundle. Type-only imports above are
// erased at compile time and don't have this problem; this one function
// does, so it's copied here instead.
function drugOnHand(entries: DrugAccountabilityRow[]): number {
  return entries.reduce((total, e) => {
    if (e.action === 'received' || e.action === 'returned') return total + e.quantity
    return total - e.quantity
  }, 0)
}

const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'
const FIELD = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none'
const LABEL = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'

function PatientSelect({ patients, value, onChange, allowNone }: { patients: PatientNameOption[]; value: string; onChange: (v: string) => void; allowNone?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={FIELD}>
      <option value="">{allowNone ? 'Site-level (no patient)' : 'Select a patient…'}</option>
      {patients.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
    </select>
  )
}

// ---------------------------------------------------------------------
// Adverse Events

const SEVERITY_STYLES: Record<AdverseEventRow['severity'], string> = {
  mild: 'border-success/30 bg-success/10 text-success',
  moderate: 'border-warning/30 bg-warning/10 text-warning',
  severe: 'border-destructive/30 bg-destructive/10 text-destructive',
}

function AddAdverseEventModal({ trialId, patients, onClose }: { trialId: string; patients: PatientNameOption[]; onClose: () => void }) {
  const router = useRouter()
  const [patientId, setPatientId] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<AdverseEventRow['severity']>('mild')
  const [serious, setSerious] = useState(false)
  const [causality, setCausality] = useState<AdverseEventRow['causality']>('unlikely')
  const [onsetDate, setOnsetDate] = useState('')
  const [reportedDate, setReportedDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = Boolean(patientId) && description.trim().length > 0 && onsetDate.length > 0 && !submitting

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/trials/${trialId}/adverse-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientId, description: description.trim(), severity, serious, causality, onsetDate, reportedDate }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not log this adverse event.')
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Log Adverse Event</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><label className={LABEL}>Patient</label><PatientSelect patients={patients} value={patientId} onChange={setPatientId} /></div>
          <div><label className={LABEL}>Description</label><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={FIELD} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>Severity</label>
              <select value={severity} onChange={(e) => setSeverity(e.target.value as AdverseEventRow['severity'])} className={FIELD}>
                <option value="mild">Mild</option>
                <option value="moderate">Moderate</option>
                <option value="severe">Severe</option>
              </select>
            </div>
            <div>
              <label className={LABEL}>Causality</label>
              <select value={causality} onChange={(e) => setCausality(e.target.value as AdverseEventRow['causality'])} className={FIELD}>
                <option value="unrelated">Unrelated</option>
                <option value="unlikely">Unlikely</option>
                <option value="possibly">Possibly</option>
                <option value="probably">Probably</option>
                <option value="definitely">Definitely</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={LABEL}>Onset date</label><input type="date" value={onsetDate} onChange={(e) => setOnsetDate(e.target.value)} className={FIELD} /></div>
            <div><label className={LABEL}>Reported date</label><input type="date" value={reportedDate} onChange={(e) => setReportedDate(e.target.value)} className={FIELD} /></div>
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={serious} onChange={(e) => setSerious(e.target.checked)} />
            This is a Serious Adverse Event (SAE) — requires sponsor/IRB notification
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>{submitting ? 'Logging…' : 'Log Event'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AdverseEventsPanel({ trialId, events, patients, canWrite }: { trialId: string; events: AdverseEventRow[]; patients: PatientNameOption[]; canWrite: boolean }) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  // Snapshot "now" once per render rather than calling Date.now() inside the
  // .map() below -- an impure call during render (flagged by the
  // react-hooks/purity rule) even though the result is only used for a
  // same-render overdue-badge computation, not stored as state.
  const [nowMs] = useState(() => Date.now())

  async function notify(id: number, which: 'sponsor' | 'irb') {
    await fetch(`/api/trials/${trialId}/adverse-events`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, which }),
    })
    router.refresh()
  }

  return (
    <div className="space-y-4">
      <section className={SECTION}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Adverse Events ({events.length})</h3>
          {canWrite && <Button size="sm" onClick={() => setAdding(true)}>Log Adverse Event</Button>}
        </div>
        {events.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No adverse events logged for this trial.</p>
        ) : (
          <div className="space-y-3">
            {events.map((e) => {
              const reportedDaysAgo = Math.floor((nowMs - new Date(e.reportedDate).getTime()) / 86400000)
              const sponsorOverdue = e.serious && !e.sponsorNotifiedAt && reportedDaysAgo >= 1
              return (
                <div key={e.id} className="rounded-md border border-border bg-secondary/40 p-3">
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">{e.patientName} <span className="font-mono text-xs text-muted-foreground">({e.patientId})</span></span>
                    <span className="flex items-center gap-1.5">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[e.severity]}`}>{e.severity}</span>
                      {e.serious && <span className="inline-flex items-center rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">SAE</span>}
                    </span>
                  </div>
                  <p className="text-sm text-foreground">{e.description}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Onset {e.onsetDate} · Reported {e.reportedDate} by {e.reportedByName} · Causality: {e.causality} · Outcome: {e.outcome}
                  </p>
                  {e.serious && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {sponsorOverdue && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                          <AlertTriangle className="h-3 w-3" aria-hidden="true" />Sponsor notification overdue
                        </span>
                      )}
                      {canWrite && !e.sponsorNotifiedAt && (
                        <Button size="sm" variant="outline" onClick={() => notify(e.id, 'sponsor')}>Mark sponsor notified</Button>
                      )}
                      {canWrite && !e.irbNotifiedAt && (
                        <Button size="sm" variant="outline" onClick={() => notify(e.id, 'irb')}>Mark IRB notified</Button>
                      )}
                      {e.sponsorNotifiedAt && <span className="text-xs text-muted-foreground">Sponsor notified {new Date(e.sponsorNotifiedAt).toLocaleDateString()}</span>}
                      {e.irbNotifiedAt && <span className="text-xs text-muted-foreground">IRB notified {new Date(e.irbNotifiedAt).toLocaleDateString()}</span>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>
      {adding && <AddAdverseEventModal trialId={trialId} patients={patients} onClose={() => setAdding(false)} />}
    </div>
  )
}

// ---------------------------------------------------------------------
// Drug Accountability

const ACTION_STYLES: Record<DrugAccountabilityRow['action'], string> = {
  received: 'border-success/30 bg-success/10 text-success',
  dispensed: 'border-primary/30 bg-primary/10 text-primary',
  returned: 'border-warning/30 bg-warning/10 text-warning',
  destroyed: 'border-destructive/30 bg-destructive/10 text-destructive',
}

function AddDrugAccountabilityModal({ trialId, patients, onClose }: { trialId: string; patients: PatientNameOption[]; onClose: () => void }) {
  const router = useRouter()
  const [patientId, setPatientId] = useState('')
  const [lotNumber, setLotNumber] = useState('')
  const [expirationDate, setExpirationDate] = useState('')
  const [action, setAction] = useState<DrugAccountabilityRow['action']>('received')
  const [quantity, setQuantity] = useState('')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const needsPatient = action === 'dispensed' || action === 'returned'
  const canSubmit = lotNumber.trim().length > 0 && expirationDate.length > 0 && Number(quantity) > 0 && (!needsPatient || Boolean(patientId)) && !submitting

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/trials/${trialId}/drug-accountability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId: patientId || null, lotNumber: lotNumber.trim(), expirationDate, action,
        quantity: Number(quantity), date, notes: notes.trim() || undefined,
      }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not log this entry.')
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Log Drug Accountability Entry</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <label className={LABEL}>Action</label>
            <select value={action} onChange={(e) => setAction(e.target.value as DrugAccountabilityRow['action'])} className={FIELD}>
              <option value="received">Received from sponsor</option>
              <option value="dispensed">Dispensed to participant</option>
              <option value="returned">Returned by participant</option>
              <option value="destroyed">Destroyed</option>
            </select>
          </div>
          {needsPatient && (
            <div><label className={LABEL}>Patient</label><PatientSelect patients={patients} value={patientId} onChange={setPatientId} /></div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div><label className={LABEL}>Lot number</label><input value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} className={FIELD} /></div>
            <div><label className={LABEL}>Quantity</label><input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={FIELD} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={LABEL}>Expiration date</label><input type="date" value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)} className={FIELD} /></div>
            <div><label className={LABEL}>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={FIELD} /></div>
          </div>
          <div><label className={LABEL}>Notes (optional)</label><input value={notes} onChange={(e) => setNotes(e.target.value)} className={FIELD} /></div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>{submitting ? 'Logging…' : 'Log Entry'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DrugAccountabilityPanel({ trialId, entries, patients, canWrite }: { trialId: string; entries: DrugAccountabilityRow[]; patients: PatientNameOption[]; canWrite: boolean }) {
  const [adding, setAdding] = useState(false)
  const onHand = drugOnHand(entries)

  return (
    <div className="space-y-4">
      <section className={SECTION}>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Drug Accountability</h3>
            <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{onHand} <span className="text-xs font-normal uppercase text-muted-foreground">units on hand</span></p>
          </div>
          {canWrite && <Button size="sm" onClick={() => setAdding(true)}>Log Entry</Button>}
        </div>
        {entries.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No drug accountability entries logged for this trial.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/40 text-left">
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Date</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Action</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lot</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Qty</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={e.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
                    <td className="p-3 text-foreground">{e.date}</td>
                    <td className="p-3"><span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${ACTION_STYLES[e.action]}`}>{e.action}</span></td>
                    <td className="p-3 text-foreground">{e.lotNumber}</td>
                    <td className="p-3 text-foreground">{e.quantity}</td>
                    <td className="p-3 text-foreground">{e.patientName ?? '—'}</td>
                    <td className="p-3 text-foreground">{e.performedByName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {adding && <AddDrugAccountabilityModal trialId={trialId} patients={patients} onClose={() => setAdding(false)} />}
    </div>
  )
}

// ---------------------------------------------------------------------
// Regulatory Documents

const DOC_TYPE_LABELS: Record<RegulatoryDocumentRow['documentType'], string> = {
  form_1572: 'Form FDA 1572',
  delegation_log: 'Delegation Log',
  irb_approval: 'IRB Approval',
  informed_consent_template: 'Informed Consent Template',
  protocol: 'Protocol',
  investigator_brochure: 'Investigator Brochure',
  other: 'Other',
}

const DOC_STATUS_STYLES: Record<RegulatoryDocumentRow['status'], string> = {
  current: 'border-success/30 bg-success/10 text-success',
  expired: 'border-destructive/30 bg-destructive/10 text-destructive',
  superseded: 'border-muted-foreground/30 bg-muted text-muted-foreground',
}

function AddRegulatoryDocumentModal({ trialId, onClose }: { trialId: string; onClose: () => void }) {
  const router = useRouter()
  const [documentType, setDocumentType] = useState<RegulatoryDocumentRow['documentType']>('irb_approval')
  const [title, setTitle] = useState('')
  const [version, setVersion] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [expirationDate, setExpirationDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = title.trim().length > 0 && effectiveDate.length > 0 && !submitting

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/trials/${trialId}/regulatory-documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentType, title: title.trim(), version: version.trim() || undefined,
        effectiveDate, expirationDate: expirationDate || undefined,
      }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not add this document.')
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add Regulatory Document</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <label className={LABEL}>Document type</label>
            <select value={documentType} onChange={(e) => setDocumentType(e.target.value as RegulatoryDocumentRow['documentType'])} className={FIELD}>
              {Object.entries(DOC_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div><label className={LABEL}>Title</label><input value={title} onChange={(e) => setTitle(e.target.value)} className={FIELD} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={LABEL}>Version (optional)</label><input value={version} onChange={(e) => setVersion(e.target.value)} className={FIELD} /></div>
            <div><label className={LABEL}>Effective date</label><input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} className={FIELD} /></div>
          </div>
          <div><label className={LABEL}>Expiration date (optional)</label><input type="date" value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)} className={FIELD} /></div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>{submitting ? 'Adding…' : 'Add Document'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RegulatoryDocumentsPanel({ trialId, documents, canWrite }: { trialId: string; documents: RegulatoryDocumentRow[]; canWrite: boolean }) {
  const [adding, setAdding] = useState(false)

  return (
    <div className="space-y-4">
      <section className={SECTION}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Regulatory Binder ({documents.length})</h3>
          {canWrite && <Button size="sm" onClick={() => setAdding(true)}>Add Document</Button>}
        </div>
        {documents.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No regulatory documents on file for this trial.</p>
        ) : (
          <ul className="space-y-2">
            {documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/40 px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">{d.title} {d.version && <span className="font-mono text-xs text-muted-foreground">v{d.version}</span>}</p>
                  <p className="text-xs text-muted-foreground">
                    {DOC_TYPE_LABELS[d.documentType]} · Effective {d.effectiveDate}{d.expirationDate ? ` · Expires ${d.expirationDate}` : ''} · Uploaded by {d.uploadedByName}
                  </p>
                </div>
                <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${DOC_STATUS_STYLES[d.status]}`}>{d.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {adding && <AddRegulatoryDocumentModal trialId={trialId} onClose={() => setAdding(false)} />}
    </div>
  )
}
