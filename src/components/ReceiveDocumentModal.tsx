'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { DOCUMENT_TYPE_TEXT, type DocumentType } from '@/lib/document-types'

const DOCUMENT_TYPES = Object.keys(DOCUMENT_TYPE_TEXT) as DocumentType[]

interface PatientOption { id: string; name: string }
interface ActiveAdmissionOption { admissionId: number; patientId: string; roomLabel: string | null; admittedAt: string }

export function ReceiveDocumentModal({ patientOptions, activeAdmissions, onClose }: {
  patientOptions: PatientOption[]
  activeAdmissions: ActiveAdmissionOption[]
  onClose: () => void
}) {
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [documentDate, setDocumentDate] = useState('')
  const [receivedFrom, setReceivedFrom] = useState('')
  const [documentType, setDocumentType] = useState<DocumentType>('other')
  const [patientId, setPatientId] = useState('')
  const [associateAdmission, setAssociateAdmission] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const matchedAdmission = patientId !== '' ? activeAdmissions.find((a) => a.patientId === patientId) ?? null : null

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null
    setFile(selected)
    if (selected) setName(selected.name)
  }

  function handlePatientChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setPatientId(e.target.value)
    setAssociateAdmission(false)
  }

  async function submit() {
    if (!file) return
    setSubmitting(true)
    setError(null)
    const formData = new FormData()
    formData.set('file', file)
    formData.set('name', name)
    formData.set('documentDate', documentDate)
    formData.set('receivedFrom', receivedFrom)
    formData.set('documentType', documentType)
    if (patientId !== '') {
      formData.set('patientId', patientId)
      if (associateAdmission && matchedAdmission) formData.set('admissionId', String(matchedAdmission.admissionId))
    }
    const res = await fetch('/api/documents', { method: 'POST', body: formData })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not receive this document.')
  }

  const canSubmit = Boolean(file) && name.trim() !== '' && documentDate !== '' && receivedFrom.trim() !== '' && !submitting

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Receive Document</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <input
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            onChange={handleFileChange}
            aria-label="File"
            className="w-full text-sm"
          />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Document name" aria-label="Document name" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <input value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} type="date" aria-label="Document date" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <input value={receivedFrom} onChange={(e) => setReceivedFrom(e.target.value)} placeholder="Received from" aria-label="Received from" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
          <select value={documentType} onChange={(e) => setDocumentType(e.target.value as DocumentType)} aria-label="Document type" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            {DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{DOCUMENT_TYPE_TEXT[t]}</option>)}
          </select>
          <select value={patientId} onChange={handlePatientChange} aria-label="Patient" className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Leave blank if unknown</option>
            {patientOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {patientId !== '' && (
            matchedAdmission ? (
              <div className="rounded-md border border-border p-2 text-xs text-muted-foreground">
                <p>Currently admitted — {matchedAdmission.roomLabel ?? 'no room assigned'}</p>
                <label className="mt-1.5 flex items-center gap-1.5">
                  <input type="checkbox" checked={associateAdmission} onChange={(e) => setAssociateAdmission(e.target.checked)} />
                  Associate with this admission
                </label>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Outpatient</p>
            )
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Receive</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
