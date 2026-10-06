'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function SendFormModal({ templates, patients, onClose }: {
  templates: { id: number; name: string }[]
  patients: { id: string; name: string }[]
  onClose: () => void
}) {
  const router = useRouter()
  const [templateId, setTemplateId] = useState<number | ''>('')
  const [patientId, setPatientId] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    setSubmitting(true)
    const res = await fetch('/api/form-submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId, patientId }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose() }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send Form to Client</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <select value={patientId} onChange={(e) => setPatientId(e.target.value)} className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a client…</option>
            {patients.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
          </select>
          <select value={templateId} onChange={(e) => setTemplateId(Number(e.target.value))} className="w-full rounded-md border border-border px-3 py-2 text-sm">
            <option value="">Select a form…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !templateId || !patientId}>Send Form</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
