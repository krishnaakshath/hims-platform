'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface DxRow { code: string; description: string }
interface ProcRow { code: string; description: string; units: number; chargeCents: number }

export function NewChargeModal({ patients }: { patients: { id: string; name: string }[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [patientId, setPatientId] = useState(patients[0]?.id ?? '')
  const [providerName, setProviderName] = useState('Dr. R. Kunam')
  const [dateOfService, setDateOfService] = useState('')
  const [dx, setDx] = useState<DxRow[]>([{ code: '', description: '' }])
  const [proc, setProc] = useState<ProcRow[]>([{ code: '', description: '', units: 1, chargeCents: 0 }])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const amountCents = proc.reduce((sum, p) => sum + p.chargeCents * p.units, 0)

  function updateDx(i: number, patch: Partial<DxRow>) {
    setDx(dx.map((row, idx) => (idx === i ? { ...row, ...patch } : row)))
  }
  function updateProc(i: number, patch: Partial<ProcRow>) {
    setProc(proc.map((row, idx) => (idx === i ? { ...row, ...patch } : row)))
  }

  async function submit() {
    setSaving(true)
    setError(null)
    const res = await fetch('/api/charges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientId, providerName, dateOfService, diagnosisCodes: dx, procedureCodes: proc }),
    })
    setSaving(false)
    if (res.ok) {
      setOpen(false)
      router.refresh()
    } else {
      const body = await res.json()
      setError(body.error ?? 'Failed to create charge.')
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>+ New Charge</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-auto">
          <DialogHeader>
            <DialogTitle>New Charge</DialogTitle>
          </DialogHeader>
          {error && <p className="text-sm font-medium text-destructive">{error}</p>}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Patient</label>
              <select value={patientId} onChange={(e) => setPatientId(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm">
                {patients.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Provider</label>
              <input value={providerName} onChange={(e) => setProviderName(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Date of Service</label>
              <input type="date" value={dateOfService} onChange={(e) => setDateOfService(e.target.value)} className="w-full rounded-md border border-border px-2 py-1.5 text-sm" />
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Diagnosis Codes</h3>
              <button type="button" onClick={() => setDx([...dx, { code: '', description: '' }])} className="text-xs font-medium text-primary hover:underline">+ Add</button>
            </div>
            <div className="space-y-2">
              {dx.map((row, i) => (
                <div key={i} className="flex min-w-0 gap-2">
                  <input value={row.code} onChange={(e) => updateDx(i, { code: e.target.value })} placeholder="Code (e.g. F33.1)" className="w-32 rounded-md border border-border px-2 py-1.5 text-sm" />
                  <input value={row.description} onChange={(e) => updateDx(i, { description: e.target.value })} placeholder="Description" className="min-w-0 flex-1 rounded-md border border-border px-2 py-1.5 text-sm" />
                  <button type="button" onClick={() => setDx(dx.filter((_, idx) => idx !== i))} disabled={dx.length === 1} className="shrink-0 rounded px-2 text-xs text-destructive hover:bg-secondary disabled:opacity-30">Remove</button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Procedure Codes</h3>
              <button type="button" onClick={() => setProc([...proc, { code: '', description: '', units: 1, chargeCents: 0 }])} className="text-xs font-medium text-primary hover:underline">+ Add</button>
            </div>
            <div className="space-y-2">
              {proc.map((row, i) => (
                <div key={i} className="flex min-w-0 gap-2">
                  <input value={row.code} onChange={(e) => updateProc(i, { code: e.target.value })} placeholder="CPT code" className="w-24 shrink-0 rounded-md border border-border px-2 py-1.5 text-sm" />
                  <input value={row.description} onChange={(e) => updateProc(i, { description: e.target.value })} placeholder="Description" className="min-w-0 flex-1 rounded-md border border-border px-2 py-1.5 text-sm" />
                  <input type="number" min={1} value={row.units} onChange={(e) => updateProc(i, { units: Number(e.target.value) })} placeholder="Units" className="w-16 shrink-0 rounded-md border border-border px-2 py-1.5 text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
                  <input type="number" min={0} value={row.chargeCents / 100} onChange={(e) => updateProc(i, { chargeCents: Math.round(Number(e.target.value) * 100) })} placeholder="$ per unit" className="w-24 shrink-0 rounded-md border border-border px-2 py-1.5 text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
                  <button type="button" onClick={() => setProc(proc.filter((_, idx) => idx !== i))} disabled={proc.length === 1} className="shrink-0 rounded px-2 text-xs text-destructive hover:bg-secondary disabled:opacity-30">Remove</button>
                </div>
              ))}
            </div>
          </div>

          <p className="text-sm font-semibold text-foreground">Total amount: ${(amountCents / 100).toFixed(2)}</p>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={saving || !patientId || !dateOfService}>
              {saving ? 'Creating...' : 'Create Charge (Draft)'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
