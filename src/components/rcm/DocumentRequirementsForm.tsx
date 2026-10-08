'use client'
import { useState } from 'react'
import { CLAIM_DOCUMENT_KINDS, CLAIM_DOCUMENT_KIND_LABEL, CLAIM_TYPES, type ClaimDocumentKind, type ClaimType } from '@/lib/rcm/constants'
import { DEFAULT_REQUIRED_DOCUMENTS, requiredDocumentKinds } from '@/lib/rcm/readiness'
import { useRcmAction } from './useRcmAction'
import { FormError, Panel, buttonClass } from './ui'

/** Per claim type: the defaults ticked; saving stores only the differences from the defaults. */
export function DocumentRequirementsForm({ payerId, overrides }: { payerId: number; overrides: { claimType: ClaimType; documentKind: ClaimDocumentKind; required: boolean }[] }) {
  const [claimType, setClaimType] = useState<ClaimType>('ipd')
  const [checked, setChecked] = useState<Record<ClaimType, ClaimDocumentKind[]>>(
    Object.fromEntries(CLAIM_TYPES.map((t) => [t, requiredDocumentKinds(t, overrides.filter((o) => o.claimType === t))])) as Record<ClaimType, ClaimDocumentKind[]>,
  )
  const run = useRcmAction()
  const current = checked[claimType]
  const defaults = DEFAULT_REQUIRED_DOCUMENTS[claimType]
  const entries = CLAIM_DOCUMENT_KINDS.filter((k) => current.includes(k) !== defaults.includes(k)).map((k) => ({ documentKind: k, required: current.includes(k) }))
  return (
    <Panel title="Required documents">
      <div className="mb-2 flex gap-2 text-sm">{CLAIM_TYPES.map((t) => <button key={t} type="button" className={`rounded-md border px-2 py-1 ${t === claimType ? 'border-primary bg-primary/10' : 'border-border'}`} onClick={() => setClaimType(t)}>{t.toUpperCase()}</button>)}</div>
      <ul className="grid gap-1 text-sm sm:grid-cols-2">
        {CLAIM_DOCUMENT_KINDS.map((k) => (
          <li key={k}><label className="flex items-center gap-2"><input type="checkbox" checked={current.includes(k)}
            onChange={(e) => setChecked((c) => ({ ...c, [claimType]: e.target.checked ? [...c[claimType], k] : c[claimType].filter((x) => x !== k) }))} />{CLAIM_DOCUMENT_KIND_LABEL[k]}{defaults.includes(k) ? ' (default)' : ''}</label></li>
        ))}
      </ul>
      <button type="button" className={`${buttonClass} mt-2`} disabled={run.busy} onClick={() => run.send(`/api/rcm/payers/${payerId}/requirements`, 'PUT', { claimType, entries })}>Save {claimType.toUpperCase()} documents</button>
      <FormError error={run.error} />
    </Panel>
  )
}
