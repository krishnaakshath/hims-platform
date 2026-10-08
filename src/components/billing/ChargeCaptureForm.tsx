'use client'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FIELD_CLASS } from '@/components/tariff/api'
import { formatPaise, parseRupeesToPaise } from '@/lib/format'
import { todayIsoIn } from '@/lib/india-time'
import type { ChargeRuleCode, ChargeViolation } from '@/lib/billing/charge-rules'
import type { LineTax } from '@/lib/billing/gst'
import { ViolationList } from './ViolationList'
import { PRICE_SOURCE_LABELS, bpToPercent } from './labels'
import { CHARGE_PROCEDURE_CODE_KINDS } from '@/lib/billing/validation'
import { CODE_SYSTEM_LABEL } from '@/lib/coding/code-systems'

type Context = { encounterId: number } | { admissionId: number }
interface ServiceOption { id: number; code: string; name: string; gstRateBp: number; departmentName?: string }
interface Preview {
  unitPricePaise: number | null
  priceSource: string | null
  taxablePaise: number | null
  estimatedTax: LineTax | null
  violations: ChargeViolation[]
  unresolved: ChargeRuleCode[]
}

const DEBOUNCE_MS = 300

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * SP4: capture one charge against a visit or stay. Every change is previewed (debounced) so the
 * clerk sees the tariff price, its source, the estimated GST and every rule result before saving.
 */
export function ChargeCaptureForm({ context, canOverride, hasPayer, today }: {
  context: Context
  canOverride: boolean
  hasPayer: boolean
  /** IST business date; defaults to today. */
  today?: string
}) {
  const router = useRouter()
  const uid = useId()
  const id = (k: string) => `${uid}-${k}`
  const defaultDate = today ?? todayIsoIn()

  const [search, setSearch] = useState('')
  const [results, setResults] = useState<ServiceOption[]>([])
  const [service, setService] = useState<ServiceOption | null>(null)
  const [quantity, setQuantity] = useState('1')
  const [serviceDate, setServiceDate] = useState(defaultDate)
  const [billTo, setBillTo] = useState<'patient' | 'payer'>('patient')
  const [preAuth, setPreAuth] = useState('')
  const [codes, setCodes] = useState<{ kind: string; code: string }[]>([])
  const [manualPrice, setManualPrice] = useState('')
  const [manualReason, setManualReason] = useState('')
  const [overrideReasons, setOverrideReasons] = useState<Partial<Record<ChargeRuleCode, string>>>({})
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitViolations, setSubmitViolations] = useState<ChargeViolation[] | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Service search (debounced). Only the latest response is applied.
  const debouncedSearch = useDebounced(search, DEBOUNCE_MS)
  const searchSeq = useRef(0)
  useEffect(() => {
    const q = debouncedSearch.trim()
    const seq = ++searchSeq.current
    if (q.length < 2 || (service && q === service.name)) return
    fetch(`/api/tariff/services?q=${encodeURIComponent(q)}`)
      .then((r) => (r.ok ? r.json() : { services: [] }))
      .then((d: { services?: ServiceOption[] }) => { if (seq === searchSeq.current) setResults((d.services ?? []).slice(0, 8)) })
      .catch(() => { if (seq === searchSeq.current) setResults([]) })
  }, [debouncedSearch, service])

  const manualPaise = manualPrice.trim() === '' ? undefined : parseRupeesToPaise(manualPrice)
  const qty = /^\d{1,4}$/.test(quantity) ? Number(quantity) : NaN

  const body = useMemo(() => {
    if (!service || !Number.isInteger(qty) || qty < 1) return null
    const overrides = Object.entries(overrideReasons)
      .filter(([, r]) => (r ?? '').trim().length > 0)
      .map(([code, reason]) => ({ code, reason: (reason ?? '').trim() }))
    return {
      context, serviceId: service.id, quantity: qty, serviceDate, billTo,
      ...(preAuth.trim() ? { preAuthReference: preAuth.trim() } : {}),
      ...(codes.some((c) => c.code.trim()) ? { procedureCodes: codes.filter((c) => c.code.trim()).map((c) => ({ kind: c.kind, code: c.code.trim() })) } : {}),
      ...(canOverride && manualPaise != null ? { manualUnitPricePaise: manualPaise, priceOverrideReason: manualReason.trim() } : {}),
      ...(overrides.length ? { overrides } : {}),
    }
  }, [context, service, qty, serviceDate, billTo, preAuth, codes, canOverride, manualPaise, manualReason, overrideReasons])

  // Live preview (debounced). A preview never saves anything.
  const debouncedBody = useDebounced(body, DEBOUNCE_MS)
  const previewSeq = useRef(0)
  useEffect(() => {
    const seq = ++previewSeq.current
    if (!debouncedBody) return
    // A manual price needs its reason before the server will price it.
    if ('manualUnitPricePaise' in debouncedBody && (debouncedBody.priceOverrideReason ?? '').length < 5) return
    fetch('/api/billing/charge-lines/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(debouncedBody) })
      .then(async (r) => {
        const d = await r.json().catch(() => null)
        if (seq !== previewSeq.current) return
        if (r.ok && d?.preview) { setPreview(d.preview); setPreviewError(null) } else { setPreview(null); setPreviewError(d?.error ?? 'Could not price this charge') }
      })
      .catch(() => { if (seq === previewSeq.current) setPreviewError('Could not reach the server to price this charge') })
  }, [debouncedBody])

  function reset() {
    setSearch(''); setResults([]); setService(null); setQuantity('1'); setServiceDate(defaultDate); setBillTo('patient')
    setPreAuth(''); setCodes([]); setManualPrice(''); setManualReason(''); setOverrideReasons({}); setPreview(null)
    setSubmitError(null); setSubmitViolations(null)
  }

  async function submit() {
    setSubmitError(null)
    setSubmitViolations(null)
    if (!body) { setSubmitError('Choose a service and a quantity from 1 to 1000'); return }
    if (manualPrice.trim() !== '' && manualPaise == null) { setSubmitError('Enter the manual price in rupees, e.g. 1,250.50'); return }
    setSubmitting(true)
    try {
      const res = await fetch('/api/billing/charge-lines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => null)
      if (res.status === 201) { reset(); router.refresh(); return }
      setSubmitError(d?.error ?? 'Could not add the charge')
      if (res.status === 422 && Array.isArray(d?.violations)) setSubmitViolations(d.violations)
    } catch {
      setSubmitError('Could not reach the server. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // Results and the preview only show while they still match the form (stale ones are hidden, not cleared).
  const visibleResults = !service && search.trim().length >= 2 ? results : []
  const shownPreview = body ? preview : null
  const shownViolations = submitViolations ?? shownPreview?.violations ?? []
  const tax = shownPreview?.estimatedTax ?? null

  return (
    <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <div className="relative">
        <Field id={id('search')} label="Search service" hint={service ? `${service.code} · GST ${bpToPercent(service.gstRateBp)}` : 'Type at least 2 letters of the service name or code'}>
          <input id={id('search')} value={search} autoComplete="off" className={FIELD_CLASS}
            onChange={(e) => { setSearch(e.target.value); setService(null); setPreview(null) }} />
        </Field>
        {visibleResults.length > 0 && (
          <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-popover shadow-md">
            {visibleResults.map((r) => (
              <li key={r.id}>
                <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => { setService(r); setSearch(r.name); setResults([]) }}>
                  <span>{r.name} <span className="text-muted-foreground">({r.code})</span></span>
                  {r.departmentName && <span className="text-xs text-muted-foreground">{r.departmentName}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field id={id('qty')} label="Quantity">
          <input id={id('qty')} type="number" min={1} max={1000} step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} className={FIELD_CLASS} />
        </Field>
        <Field id={id('date')} label="Service date">
          <input id={id('date')} type="date" value={serviceDate} max={defaultDate} onChange={(e) => setServiceDate(e.target.value)} className={FIELD_CLASS} />
        </Field>
        <Field id={id('billto')} label="Bill to">
          <select id={id('billto')} value={billTo} onChange={(e) => setBillTo(e.target.value as 'patient' | 'payer')} className={FIELD_CLASS}>
            <option value="patient">Patient (self-pay)</option>
            <option value="payer" disabled={!hasPayer}>Payer (primary insurer){hasPayer ? '' : ' — none on file'}</option>
          </select>
        </Field>
      </div>

      <Field id={id('preauth')} label="Pre-authorisation reference">
        <input id={id('preauth')} value={preAuth} maxLength={40} onChange={(e) => setPreAuth(e.target.value)} className={FIELD_CLASS} />
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-muted-foreground">Procedure codes</legend>
        {codes.map((c, i) => (
          <div key={i} className="flex gap-2">
            <select aria-label={`Code system ${i + 1}`} value={c.kind} className={`${FIELD_CLASS} w-44`}
              onChange={(e) => setCodes(codes.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}>
              {CHARGE_PROCEDURE_CODE_KINDS.map((k) => <option key={k} value={k}>{CODE_SYSTEM_LABEL[k]}</option>)}
            </select>
            <input aria-label={`Code ${i + 1}`} placeholder="Code" value={c.code} maxLength={20} className={FIELD_CLASS}
              onChange={(e) => setCodes(codes.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} />
            <Button type="button" variant="outline" size="icon" aria-label={`Remove code ${i + 1}`} onClick={() => setCodes(codes.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ))}
        {codes.length < 5 && (
          <Button type="button" variant="outline" size="sm" onClick={() => setCodes([...codes, { kind: CHARGE_PROCEDURE_CODE_KINDS[0], code: '' }])}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Add procedure code
          </Button>
        )}
      </fieldset>

      {canOverride && (
        <div className="grid gap-3 rounded-md border border-dashed border-border p-3 sm:grid-cols-2">
          <Field id={id('manual')} label="Manual unit price (₹)" hint="Leave blank to use the tariff price">
            <input id={id('manual')} inputMode="decimal" value={manualPrice} onChange={(e) => setManualPrice(e.target.value)} className={FIELD_CLASS} />
          </Field>
          <Field id={id('manualreason')} label="Reason for manual price">
            <input id={id('manualreason')} value={manualReason} maxLength={300} onChange={(e) => setManualReason(e.target.value)} className={FIELD_CLASS} />
          </Field>
        </div>
      )}

      {shownPreview && (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm" aria-live="polite">
          {shownPreview.unitPricePaise === null ? (
            <p className="font-medium text-destructive">No tariff price covers this service on this date.</p>
          ) : (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
              <div><dt className="text-xs text-muted-foreground">Unit price</dt><dd className="font-semibold tabular-nums">{formatPaise(shownPreview.unitPricePaise)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Price source</dt><dd>{PRICE_SOURCE_LABELS[shownPreview.priceSource ?? ''] ?? shownPreview.priceSource}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Taxable</dt><dd className="tabular-nums">{formatPaise(shownPreview.taxablePaise ?? 0)}</dd></div>
              <div>
                <dt className="text-xs text-muted-foreground">Estimated GST</dt>
                <dd className="tabular-nums">{tax ? formatPaise(tax.taxPaise) : 'Set the hospital state to estimate'}</dd>
              </div>
            </dl>
          )}
        </div>
      )}
      {previewError && <p className="text-sm text-destructive">{previewError}</p>}

      <ViolationList
        violations={shownViolations}
        canOverride={canOverride}
        overrideReasons={overrideReasons}
        onOverrideReason={(code, reason) => setOverrideReasons({ ...overrideReasons, [code]: reason })}
      />

      {submitError && <p role="alert" className="text-sm font-medium text-destructive">{submitError}</p>}

      <div className="flex justify-end">
        <Button type="submit" disabled={submitting || !service}>{submitting ? 'Adding…' : 'Add charge'}</Button>
      </div>
    </form>
  )
}
