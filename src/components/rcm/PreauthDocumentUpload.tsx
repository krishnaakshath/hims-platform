'use client'
import { useState } from 'react'
import { useRcmAction } from './useRcmAction'
import { Field, FormError, buttonClass, inputClass } from './ui'

export function PreauthDocumentUpload({ preauthId }: { preauthId: number }) {
  const [kind, setKind] = useState<'preauth_approval' | 'query_response' | 'other'>('preauth_approval')
  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const run = useRcmAction()
  return (
    <form className="mt-2 grid gap-2 sm:grid-cols-4" onSubmit={async (e) => { e.preventDefault(); if (!file) { run.setError('Choose a file'); return }
      const f = new FormData(); f.set('kind', kind); f.set('title', title.trim() || 'Document'); f.set('file', file)
      if (await run.upload(`/api/rcm/preauths/${preauthId}/documents`, f)) { setTitle(''); setFile(null) } }}>
      <Field label="Kind"><select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="preauth_approval">Approval letter</option><option value="query_response">Query reply</option><option value="other">Other</option></select></Field>
      <Field label="Title"><input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="File (PDF, JPEG or PNG, up to 4 MB)"><input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      <div className="flex items-end"><button type="submit" className={buttonClass} disabled={run.busy}>Upload</button></div>
      <div className="sm:col-span-4"><FormError error={run.error} /></div>
    </form>
  )
}
