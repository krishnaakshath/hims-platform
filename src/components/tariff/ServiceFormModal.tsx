'use client'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  GST_RATES_BP, SERVICE_CATEGORIES, serviceCreateSchema, serviceUpdateSchema, type ServiceCategory,
} from '@/lib/tariff/validation'
import { FIELD_CLASS, sendJson } from './api'

export interface DepartmentOption { id: number; code: string; name: string }
export interface ServiceFormValues {
  id: number
  code: string
  name: string
  departmentId: number
  category: ServiceCategory
  hsnSac: string
  gstRateBp: number
}

type Props =
  | { mode: 'create'; departments: DepartmentOption[]; onClose: () => void; service?: undefined }
  | { mode: 'edit'; departments: DepartmentOption[]; onClose: () => void; service: ServiceFormValues }

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {error && <p id={`${id}-error`} className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}

export function ServiceFormModal(props: Props) {
  const { mode, departments, onClose } = props
  const router = useRouter()
  const uid = useId()
  const s = props.service
  const [code, setCode] = useState(s?.code ?? '')
  const [name, setName] = useState(s?.name ?? '')
  const [departmentId, setDepartmentId] = useState(s ? String(s.departmentId) : '')
  const [category, setCategory] = useState<string>(s?.category ?? '')
  const [hsnSac, setHsnSac] = useState(s?.hsnSac ?? '')
  const [gstRateBp, setGstRateBp] = useState(s ? String(s.gstRateBp) : '')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    setServerError(null)
    const payload = {
      ...(mode === 'create' ? { code } : {}),
      name,
      departmentId: departmentId ? Number(departmentId) : undefined,
      category: category || undefined,
      hsnSac,
      gstRateBp: gstRateBp === '' ? undefined : Number(gstRateBp),
    }
    const parsed = mode === 'create' ? serviceCreateSchema.safeParse(payload) : serviceUpdateSchema.safeParse(payload)
    if (!parsed.success) {
      const errs: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form')
        // Required-field type errors read as "expected number/string"; say it plainly instead.
        errs[key] ??= issue.code === 'invalid_type' || issue.code === 'invalid_value' ? 'This field is required' : issue.message
      }
      setFieldErrors(errs)
      return
    }
    setFieldErrors({})
    setSubmitting(true)
    const res = mode === 'create'
      ? await sendJson('/api/tariff/services', 'POST', parsed.data)
      : await sendJson(`/api/tariff/services/${s!.id}`, 'PATCH', parsed.data)
    setSubmitting(false)
    if (res.ok) { router.refresh(); onClose(); return }
    setServerError(res.error)
  }

  const id = (k: string) => `${uid}-${k}`
  const invalid = (k: string) => (fieldErrors[k] ? true : undefined)

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'New service' : `Edit service ${s!.code}`}</DialogTitle>
        </DialogHeader>
        <form className="space-y-3" noValidate onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id={id('code')} label="Code" error={fieldErrors.code}>
              <input id={id('code')} value={code} onChange={(e) => setCode(e.target.value)} readOnly={mode === 'edit'} aria-invalid={invalid('code')}
                aria-describedby={fieldErrors.code ? `${id('code')}-error` : undefined} maxLength={24} className={`${FIELD_CLASS} ${mode === 'edit' ? 'bg-muted' : ''}`} />
            </Field>
            <Field id={id('name')} label="Name" error={fieldErrors.name}>
              <input id={id('name')} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={invalid('name')} maxLength={200} className={FIELD_CLASS} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id={id('dept')} label="Department" error={fieldErrors.departmentId}>
              <select id={id('dept')} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-invalid={invalid('departmentId')} className={FIELD_CLASS}>
                <option value="">Select department</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field id={id('cat')} label="Category" error={fieldErrors.category}>
              <select id={id('cat')} value={category} onChange={(e) => setCategory(e.target.value)} aria-invalid={invalid('category')} className={FIELD_CLASS}>
                <option value="">Select category</option>
                {SERVICE_CATEGORIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id={id('hsn')} label="HSN/SAC" error={fieldErrors.hsnSac}>
              <input id={id('hsn')} value={hsnSac} onChange={(e) => setHsnSac(e.target.value)} inputMode="numeric" aria-invalid={invalid('hsnSac')} className={FIELD_CLASS} />
            </Field>
            <Field id={id('gst')} label="GST rate" error={fieldErrors.gstRateBp}>
              <select id={id('gst')} value={gstRateBp} onChange={(e) => setGstRateBp(e.target.value)} aria-invalid={invalid('gstRateBp')} className={FIELD_CLASS}>
                <option value="">Select GST rate</option>
                {GST_RATES_BP.map((bp) => <option key={bp} value={bp}>{bp / 100}%</option>)}
              </select>
            </Field>
          </div>
          {serverError && <p role="alert" className="text-sm text-destructive">{serverError}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={submitting}>{mode === 'create' ? 'Create service' : 'Save changes'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
