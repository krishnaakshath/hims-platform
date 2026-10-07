'use client'
// SP6 Task 14: the procedure codes mapped to one service-catalogue entry, with an editor (CODING_ROLES).
// The CodePicker is limited to the kinds the service's category may carry; one code may be marked
// primary. Saving PUTs the whole map; a refusal shows the server's message and problems in an alert.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CODE_SYSTEM_LABEL, type CodeSystemKind } from '@/lib/coding/code-systems'
import { Button } from '@/components/ui/button'
import { NETWORK_ERROR, type CodeSearchHit } from './codingApi'
import { CodePicker, SampleBadge } from './CodePicker'

export interface ServiceCodeView {
  kind: CodeSystemKind
  code: string
  isPrimary: boolean
  display: string | null
  isSample: boolean
}

export interface ServiceView {
  id: number
  code: string
  name: string
  categoryLabel: string
  isActive: boolean
  kinds: readonly CodeSystemKind[]
  codes: ServiceCodeView[]
}

const same = (a: { kind: CodeSystemKind; code: string }, b: { kind: CodeSystemKind; code: string }) => a.kind === b.kind && a.code === b.code

function CodeList({ codes }: { codes: ServiceCodeView[] }) {
  if (codes.length === 0) return <p className="text-sm text-muted-foreground">No procedure codes mapped (charges are not checked against codes).</p>
  return (
    <ul className="space-y-1 text-sm">
      {codes.map((c) => (
        <li key={`${c.kind}:${c.code}`} className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{CODE_SYSTEM_LABEL[c.kind]}</span>
          <span className="font-mono text-xs font-semibold">{c.code}</span>
          <span>{c.display ?? <span className="text-muted-foreground">Not in the current code set</span>}</span>
          {c.isSample && <SampleBadge />}
          {c.isPrimary && <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium">Primary</span>}
        </li>
      ))}
    </ul>
  )
}

export function ServiceCodeEditor({ service, todayIso, canEdit }: { service: ServiceView; todayIso: string; canEdit: boolean }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<ServiceCodeView[]>(service.codes)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; problems: string[] } | null>(null)

  function start() { setDraft(service.codes); setError(null); setEditing(true) }
  function add(hit: CodeSearchHit) {
    if (draft.some((c) => same(c, hit))) return
    setDraft([...draft, { kind: hit.kind, code: hit.code, display: hit.display, isSample: hit.isSample, isPrimary: draft.length === 0 }])
  }
  const remove = (c: ServiceCodeView) => setDraft(draft.filter((d) => !same(d, c)))
  const makePrimary = (c: ServiceCodeView) => setDraft(draft.map((d) => ({ ...d, isPrimary: same(d, c) })))

  async function save() {
    setBusy(true)
    setError(null)
    let res: Response
    try {
      res = await fetch(`/api/coding/services/${service.id}/procedure-codes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: draft.map(({ kind, code, isPrimary }) => ({ kind, code, isPrimary })) }),
      })
    } catch {
      setBusy(false)
      setError({ message: NETWORK_ERROR, problems: [] })
      return
    }
    const body = (await res.json().catch(() => null)) as { error?: unknown; problems?: unknown } | null
    setBusy(false)
    if (!res.ok) {
      setError({
        message: typeof body?.error === 'string' ? body.error : 'The mapping could not be saved.',
        problems: Array.isArray(body?.problems) ? body.problems.filter((p): p is string => typeof p === 'string') : [],
      })
      return
    }
    setEditing(false)
    router.refresh()
  }

  const headingId = `service-${service.id}`
  return (
    <article aria-labelledby={headingId} className="space-y-2 rounded-lg border border-border p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-sm font-semibold">
          <span className="font-mono text-xs text-muted-foreground">{service.code}</span> {service.name}
        </h2>
        <span className="text-xs text-muted-foreground">
          {service.categoryLabel}{service.isActive ? '' : ' · Inactive'} · {service.kinds.map((k) => CODE_SYSTEM_LABEL[k]).join(', ')}
        </span>
      </header>

      {!editing ? (
        <>
          <CodeList codes={service.codes} />
          {canEdit && <Button type="button" size="sm" variant="outline" onClick={start} aria-label={`Edit procedure codes for ${service.name}`}>Edit codes</Button>}
        </>
      ) : (
        <div className="space-y-3">
          {draft.length === 0 ? (
            <p className="text-sm text-muted-foreground">No codes. Saving an empty list removes the mapping.</p>
          ) : (
            <fieldset className="space-y-1.5">
              <legend className="text-xs font-medium">Mapped codes (choose the primary one)</legend>
              {draft.map((c) => (
                <div key={`${c.kind}:${c.code}`} className="flex flex-wrap items-center gap-2 text-sm">
                  <label className="flex items-center gap-1.5">
                    <input type="radio" name={`primary-${service.id}`} checked={c.isPrimary} onChange={() => makePrimary(c)} />
                    <span className="text-xs text-muted-foreground">{CODE_SYSTEM_LABEL[c.kind]}</span>
                    <span className="font-mono text-xs font-semibold">{c.code}</span>
                    <span>{c.display}</span>
                  </label>
                  {c.isSample && <SampleBadge />}
                  <Button type="button" size="xs" variant="ghost" onClick={() => remove(c)} aria-label={`Remove ${c.code}`}>Remove</Button>
                </div>
              ))}
            </fieldset>
          )}
          <CodePicker kinds={service.kinds} onDate={todayIso} onPick={add} label={`Search codes to map to ${service.name}`} />
          {error && (
            <div role="alert" className="text-sm text-destructive">
              <p>{error.message}</p>
              {error.problems.length > 0 && <ul className="list-disc ps-5">{error.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
            </div>
          )}
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={save}>Save codes</Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </article>
  )
}
