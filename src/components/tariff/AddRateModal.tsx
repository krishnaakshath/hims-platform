'use client'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { parseRupeesToPaise } from '@/lib/money'
import { rateCreateSchema, RATE_SCOPES, type ServiceCategory } from '@/lib/tariff/validation'
import { AMOUNT_HELP } from './ReviseRateModal'
import { FIELD_CLASS, sendJson } from './api'

const SCOPE_LABEL: Record<(typeof RATE_SCOPES)[number], string> = {
  base: 'Base price',
  department: 'Department price list',
  payer: 'Payer / TPA tariff',
}

export interface AddRateProps {
  serviceId: number
  serviceCategory: ServiceCategory
  today: string
  departments: { id: number; code: string; name: string }[]
  payers: { id: number; name: string }[]
  roomCategories: { id: number; code: string; name: string }[]
}

export function AddRateModal(props: AddRateProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Add rate</Button>
      {open && <AddRateForm {...props} onClose={() => setOpen(false)} />}
    </>
  )
}

function AddRateForm({ serviceId, serviceCategory, today, departments, payers, roomCategories, onClose }: AddRateProps & { onClose: () => void }) {
  const router = useRouter()
  const uid = useId()
  const [scope, setScope] = useState<(typeof RATE_SCOPES)[number]>('base')
  const [departmentId, setDepartmentId] = useState('')
  const [payerId, setPayerId] = useState('')
  const [roomCategoryId, setRoomCategoryId] = useState('')
  const [ward, setWard] = useState('')
  const [amount, setAmount] = useState('')
  const [validFrom, setValidFrom] = useState(today)
  const [validTo, setValidTo] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const perDay = serviceCategory === 'room_rent' ? 'per day, ' : ''
  const id = (k: string) => `${uid}-${k}`

  async function submit() {
    setServerError(null)
    const errs: Record<string, string> = {}
    const paise = parseRupeesToPaise(amount)
    if (paise === null) errs.amount = AMOUNT_HELP
    if (scope === 'department' && !departmentId) errs.department = 'Choose a department'
    if (scope === 'payer' && !payerId) errs.payer = 'Choose a payer'
    if (Object.keys(errs).length > 0) { setErrors(errs); return }

    const payload = {
      serviceId,
      scope,
      ...(scope === 'department' ? { departmentId: Number(departmentId) } : {}),
      ...(scope === 'payer' ? { payerId: Number(payerId) } : {}),
      ...(roomCategoryId ? { roomCategoryId: Number(roomCategoryId) } : {}),
      ...(ward.trim() ? { ward: ward.trim() } : {}),
      amountPaise: paise as number,
      validFrom,
      ...(validTo ? { validTo } : {}),
    }
    const parsed = rateCreateSchema.safeParse(payload)
    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) next[String(issue.path[0] ?? 'form')] ??= issue.message
      setErrors(next)
      return
    }
    setErrors({})
    setSubmitting(true)
    const res = await sendJson('/api/tariff/rates', 'POST', parsed.data)
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    setServerError(res.error)
  }

  const err = (k: string) => errors[k] && <p className="mt-1 text-xs text-destructive">{errors[k]}</p>
  const lbl = 'mb-1 block text-xs font-medium text-muted-foreground'

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader><DialogTitle>Add rate</DialogTitle></DialogHeader>
        <form className="space-y-3" noValidate onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <div>
            <label htmlFor={id('scope')} className={lbl}>Scope</label>
            <select id={id('scope')} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} className={FIELD_CLASS}>
              {RATE_SCOPES.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
            </select>
            {err('scope')}
          </div>
          {scope === 'department' && (
            <div>
              <label htmlFor={id('dept')} className={lbl}>Department</label>
              <select id={id('dept')} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={FIELD_CLASS}>
                <option value="">Select department</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              {err('department')}
            </div>
          )}
          {scope === 'payer' && (
            <div>
              <label htmlFor={id('payer')} className={lbl}>Payer</label>
              <select id={id('payer')} value={payerId} onChange={(e) => setPayerId(e.target.value)} className={FIELD_CLASS}>
                <option value="">Select payer</option>
                {payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {err('payer')}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={id('room')} className={lbl}>{`Room category (${perDay}optional)`}</label>
              <select id={id('room')} value={roomCategoryId} onChange={(e) => setRoomCategoryId(e.target.value)} className={FIELD_CLASS}>
                <option value="">Any room category</option>
                {roomCategories.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={id('ward')} className={lbl}>{`Ward (${perDay}optional)`}</label>
              <input id={id('ward')} value={ward} onChange={(e) => setWard(e.target.value)} maxLength={60} className={FIELD_CLASS} />
              {err('ward')}
            </div>
          </div>
          <div>
            <label htmlFor={id('amt')} className={lbl}>Amount (₹)</label>
            <input id={id('amt')} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoComplete="off" aria-invalid={errors.amount ? true : undefined} className={FIELD_CLASS} />
            {err('amount')}{err('amountPaise')}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={id('from')} className={lbl}>Valid from</label>
              <input id={id('from')} type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} className={FIELD_CLASS} />
              {err('validFrom')}
            </div>
            <div>
              <label htmlFor={id('to')} className={lbl}>Valid to (optional)</label>
              <input id={id('to')} type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} className={FIELD_CLASS} />
              {err('validTo')}
            </div>
          </div>
          {serverError && <p role="alert" className="text-sm text-destructive">{serverError}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={submitting}>Save rate</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
