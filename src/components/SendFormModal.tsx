'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { sendJson } from '@/lib/client-fetch'

export function SendFormModal({ templates, patients, onClose }: {
  templates: { id: number; name: string }[]
  patients: { id: string; name: string }[]
  onClose: () => void
}) {
  const router = useRouter()
  const [templateId, setTemplateId] = useState<number | ''>('')
  const [patientId, setPatientId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // After a successful send, the intake link to hand the patient.
  const [intakePath, setIntakePath] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const result = await sendJson<{ accessToken?: string | null }>('/api/form-submissions', 'POST', { templateId, patientId })
    setSubmitting(false)
    if (!result.ok) { setError(result.error); return }
    router.refresh()
    if (result.data?.accessToken) setIntakePath(`/intake/${result.data.accessToken}`)
    else onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send Form to Client</DialogTitle>
        </DialogHeader>
        {intakePath ? (
          <div className="space-y-2" role="status">
            <p className="text-sm">Form sent. Share this intake link with the patient:</p>
            <input readOnly aria-label="Intake link" value={`${typeof window === 'undefined' ? '' : window.location.origin}${intakePath}`} onFocus={(e) => e.currentTarget.select()} className="w-full rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs" />
          </div>
        ) : (
        <div className="space-y-3">
          <select value={patientId} onChange={(e) => setPatientId(e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a client…</option>
            {patients.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
          </select>
          <select value={templateId} onChange={(e) => setTemplateId(Number(e.target.value))} className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a form…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        )}
        <DialogFooter>
          {intakePath ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={submit} disabled={submitting || !templateId || !patientId}>{submitting ? 'Sending…' : 'Send Form'}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
