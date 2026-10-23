'use client'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// WS8 T14 (spec D18): the fulfilment checklist, status, decision note, export bundle and erasure for
// one data-principal request. Labels and keys come from the server page.
type Status = 'received' | 'in_progress' | 'completed' | 'rejected'

export interface DataRequestActionsProps {
  id: number
  kind: 'access' | 'correction' | 'erasure' | 'grievance'
  status: Status
  closed: boolean
  hasPatient: boolean
  hasExport: boolean
  patientUhid: string | null
  checklist: Record<string, boolean>
  checklistItems: { key: string; label: string }[]
  statusOptions: { value: Status; label: string }[]
  decisionNote: string | null
}

const SELECT = 'h-9 rounded-md border border-border bg-transparent px-3 text-sm'

export function DataRequestActions(props: DataRequestActionsProps) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>(props.status)
  const [decisionNote, setDecisionNote] = useState(props.decisionNote ?? '')
  const [confirmUhid, setConfirmUhid] = useState('')
  const [erasure, setErasure] = useState<{ outcome: 'restricted' | 'erased'; reasons?: string[] } | null>(null)
  const ids = { status: useId(), note: useId(), uhid: useId() }

  async function run(label: string, url: string, method: 'POST' | 'PATCH', body: unknown) {
    setBusy(label)
    setError(null)
    const res = await sendJson<{ outcome?: 'restricted' | 'erased'; reasons?: string[] }>(url, method, body)
    setBusy(null)
    if (!res.ok) {
      setError(res.error)
      return null
    }
    router.refresh()
    return res.data
  }

  const base = `/api/governance/data-requests/${props.id}`

  return (
    <div className="space-y-6">
      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}

      <section aria-labelledby="checklist-heading">
        <h2 id="checklist-heading" className="mb-2 text-base font-semibold text-foreground">Fulfilment checklist</h2>
        <ul className="space-y-2">
          {props.checklistItems.map((item) => (
            <li key={item.key}>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={props.checklist[item.key] === true}
                  disabled={busy !== null}
                  onChange={(e) => run('checklist', base, 'PATCH', { checklist: { [item.key]: e.target.checked } })}
                />
                {item.label}
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="status-heading" className="space-y-2">
        <h2 id="status-heading" className="text-base font-semibold text-foreground">Status and decision</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor={ids.status} className="text-sm font-medium text-foreground">Status</label>
            <select id={ids.status} value={status} onChange={(e) => setStatus(e.target.value as Status)} className={`${SELECT} block`}>
              {props.statusOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="min-w-64 flex-1 space-y-1">
            <label htmlFor={ids.note} className="text-sm font-medium text-foreground">Decision note</label>
            <Input id={ids.note} value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} maxLength={1000} />
          </div>
          <Button disabled={busy !== null} onClick={() => run('status', base, 'PATCH', { status, decisionNote })}>
            {busy === 'status' ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </section>

      {props.hasPatient && (
        <section aria-labelledby="export-heading" className="space-y-2">
          <h2 id="export-heading" className="text-base font-semibold text-foreground">Export bundle</h2>
          <p className="text-sm text-muted-foreground">The patient&apos;s records as a FHIR Bundle with a manifest, as one JSON file. Every download is recorded in the audit log.</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" disabled={busy !== null} onClick={() => run('export', `${base}/export`, 'POST', {})}>
              {busy === 'export' ? 'Preparing…' : props.hasExport ? 'Prepare again' : 'Prepare export'}
            </Button>
            {props.hasExport && <a href={`${base}/export/download`} className="text-sm font-medium text-primary underline-offset-4 hover:underline">Download export</a>}
          </div>
        </section>
      )}

      {props.kind === 'erasure' && props.hasPatient && !props.closed && (
        <section aria-labelledby="erase-heading" className="space-y-2 rounded-md border border-destructive/30 p-4">
          <h2 id="erase-heading" className="text-base font-semibold text-foreground">Act on the erasure</h2>
          <p className="text-sm text-muted-foreground">
            If the retention schedule keeps any records (bills, receipts, insurance claims, a medico-legal case, or a visit in the
            retention period), the chart is archived and its phone, email, address, photo and portal sign-in are removed; every
            clinical and financial record is kept. Otherwise the chart is deleted permanently.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label htmlFor={ids.uhid} className="text-sm font-medium text-foreground">UHID</label>
              <p className="text-xs text-muted-foreground">
                {props.patientUhid ? <>Type <span className="font-mono font-medium text-foreground">{props.patientUhid}</span> to confirm.</> : <>Type the patient&apos;s UHID to confirm.</>}
              </p>
              <Input id={ids.uhid} value={confirmUhid} onChange={(e) => setConfirmUhid(e.target.value)} autoComplete="off" spellCheck={false} maxLength={64} />
            </div>
            <Button
              variant="destructive"
              disabled={busy !== null || confirmUhid.trim() === ''}
              onClick={async () => {
                const data = await run('erase', `${base}/erase`, 'POST', { confirmUhid: confirmUhid.trim() })
                if (data?.outcome) setErasure({ outcome: data.outcome, reasons: data.reasons })
              }}
            >
              {busy === 'erase' ? 'Working…' : 'Act on erasure'}
            </Button>
          </div>
        </section>
      )}

      {erasure && (
        <div role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm text-foreground">
          {erasure.outcome === 'erased' ? (
            <p>The chart was deleted. This register entry is kept.</p>
          ) : (
            <>
              <p>Records must be kept, so the chart was archived and its contact details removed:</p>
              <ul className="mt-1 list-disc pl-5">
                {(erasure.reasons ?? []).map((r) => <li key={r}>{r}</li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}
