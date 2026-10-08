'use client'
import { useState } from 'react'
import { CLAIM_DOCUMENT_KINDS, CLAIM_DOCUMENT_KIND_LABEL, ID_PROOF_TYPES, ID_PROOF_TYPE_LABEL, type ClaimDocumentKind, type IdProofType } from '@/lib/rcm/constants'
import type { ClaimWorkspace } from '@/lib/queries/claim-workspace'
import { useRcmAction } from './useRcmAction'
import { Field, FormError, Panel, buttonClass, inputClass, secondaryButtonClass } from './ui'

export function ClaimDocumentsPanel({ claimId, documents, editable }: { claimId: number; documents: ClaimWorkspace['documents']; editable: boolean }) {
  const live = documents.filter((d) => d.supersededAt === null)
  const [kind, setKind] = useState<ClaimDocumentKind>('claim_form')
  const [title, setTitle] = useState('')
  const [idProofType, setIdProofType] = useState<IdProofType>('pan')
  const [masked, setMasked] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [labReportId, setLabReportId] = useState('')
  const action = useRcmAction()

  async function upload(e: React.FormEvent) {
    e.preventDefault()
    if (!file) { action.setError('Choose a file'); return }
    const form = new FormData()
    form.set('kind', kind)
    form.set('title', title.trim() || CLAIM_DOCUMENT_KIND_LABEL[kind])
    if (kind === 'id_proof') { form.set('idProofType', idProofType); if (masked) form.set('maskedConfirmed', 'true') }
    form.set('file', file)
    if (await action.upload(`/api/rcm/claims/${claimId}/documents`, form)) { setTitle(''); setFile(null) }
  }

  return (
    <div id="documents">
      <Panel title="Documents">
        <ul className="space-y-1 text-sm">
          {live.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-1">
              <span>{CLAIM_DOCUMENT_KIND_LABEL[d.kind as ClaimDocumentKind] ?? d.kind}: {d.waived ? <em>waived</em> : d.source === 'invoice' || d.source === 'discharge_summary' ? d.title : <a className="text-primary hover:underline" href={`/api/rcm/claim-documents/${d.id}`} target="_blank" rel="noreferrer">{d.title}</a>}
                {d.sha256 && <span className="ml-1 font-mono text-xs text-muted-foreground">{d.sha256.slice(0, 12)}</span>}</span>
              {editable && <button type="button" className={secondaryButtonClass} disabled={action.busy} onClick={() => action.send(`/api/rcm/claims/${claimId}/documents/${d.id}`, 'DELETE')}>Remove</button>}
            </li>
          ))}
        </ul>
        {editable && (
          <form onSubmit={upload} className="mt-3 grid gap-2 sm:grid-cols-2">
            <Field label="Kind"><select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as ClaimDocumentKind)}>{CLAIM_DOCUMENT_KINDS.map((k) => <option key={k} value={k}>{CLAIM_DOCUMENT_KIND_LABEL[k]}</option>)}</select></Field>
            <Field label="Title"><input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
            {kind === 'id_proof' && (
              <>
                <Field label="ID type"><select className={inputClass} value={idProofType} onChange={(e) => setIdProofType(e.target.value as IdProofType)}>{ID_PROOF_TYPES.map((t) => <option key={t} value={t}>{ID_PROOF_TYPE_LABEL[t]}</option>)}</select></Field>
                {idProofType === 'masked_uid' && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={masked} onChange={(e) => setMasked(e.target.checked)} />The first 8 digits are hidden on this copy</label>}
              </>
            )}
            <Field label="File (PDF, JPEG or PNG, up to 4 MB)"><input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
            <div className="flex items-end"><button type="submit" className={buttonClass} disabled={action.busy}>Upload</button></div>
          </form>
        )}
        {editable && (
          <div className="mt-3 flex items-end gap-2">
            <Field label="Attach lab report (report id)"><input className={inputClass} value={labReportId} onChange={(e) => setLabReportId(e.target.value)} inputMode="numeric" /></Field>
            <button type="button" className={secondaryButtonClass} disabled={action.busy || !/^\d+$/.test(labReportId)}
              onClick={async () => { if (await action.send(`/api/rcm/claims/${claimId}/documents/attach`, 'POST', { labReportId: Number(labReportId) })) setLabReportId('') }}>Attach</button>
          </div>
        )}
        <FormError error={action.error} />
      </Panel>
    </div>
  )
}
