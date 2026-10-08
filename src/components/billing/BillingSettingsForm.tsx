'use client'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { FIELD_CLASS, sendJson } from '@/components/tariff/api'
import { formatPaise, parseRupeesToPaise } from '@/lib/format'
import { INDIAN_STATES, stateName } from '@/lib/india/reference'
import { GST_RATES_BP } from '@/lib/tariff/validation'
import { billingSettingsSchema } from '@/lib/billing/validation'
import { bpToPercent } from './labels'

export interface BillingSettingsView {
  legalName: string | null
  gstin: string | null
  stateCode: string | null
  address: string | null
  placeOfSupplyMode: 'location_of_service' | 'recipient_state'
  consultationWindowDays: number
  ipdDepositThresholdPaise: number
  roomRentServiceId: number | null
  pharmacyGstRateBp: number
  pharmacyHsn: string
}

const POS_LABEL = {
  location_of_service: 'Where the service is performed (hospital state; CGST + SGST)',
  recipient_state: "The payer's or patient's state (IGST when it differs)",
} as const

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-border py-2 sm:grid-cols-[16rem_1fr]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

/** SP4: hospital billing settings. Editable for BILLING_CONFIG_ROLES (admin) only; read-only otherwise. */
export function BillingSettingsForm({ settings, roomRentServices, editable }: {
  settings: BillingSettingsView
  roomRentServices: { id: number; code: string; name: string }[]
  editable: boolean
}) {
  const router = useRouter()
  const uid = useId()
  const id = (k: string) => `${uid}-${k}`
  const [v, setV] = useState({
    legalName: settings.legalName ?? '', gstin: settings.gstin ?? '', stateCode: settings.stateCode ?? '', address: settings.address ?? '',
    placeOfSupplyMode: settings.placeOfSupplyMode, consultationWindowDays: String(settings.consultationWindowDays),
    deposit: settings.ipdDepositThresholdPaise ? (settings.ipdDepositThresholdPaise / 100).toFixed(2) : '0',
    roomRentServiceId: settings.roomRentServiceId ? String(settings.roomRentServiceId) : '', pharmacyGstRateBp: String(settings.pharmacyGstRateBp), pharmacyHsn: settings.pharmacyHsn,
  })
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => { setV({ ...v, [k]: e.target.value }); setSaved(false) }

  if (!editable) {
    const service = roomRentServices.find((s) => s.id === settings.roomRentServiceId)
    return (
      <dl>
        <Row label="Legal name">{settings.legalName ?? 'Not set'}</Row>
        <Row label="GSTIN">{settings.gstin ?? 'Not registered'}</Row>
        <Row label="State">{settings.stateCode ? stateName(settings.stateCode) : 'Not set'}</Row>
        <Row label="Address"><span className="whitespace-pre-line">{settings.address ?? '—'}</span></Row>
        <Row label="Place of supply">{POS_LABEL[settings.placeOfSupplyMode]}</Row>
        <Row label="Consultation window">{settings.consultationWindowDays} days</Row>
        <Row label="IPD deposit before procedures">{settings.ipdDepositThresholdPaise > 0 ? formatPaise(settings.ipdDepositThresholdPaise) : 'No deposit required'}</Row>
        <Row label="Room-rent service">{service ? `${service.name} (${service.code})` : 'Not set'}</Row>
        <Row label="Pharmacy GST">{bpToPercent(settings.pharmacyGstRateBp)} · HSN {settings.pharmacyHsn}</Row>
        <p className="pt-2 text-xs text-muted-foreground">Only an administrator can change these settings.</p>
      </dl>
    )
  }

  async function save() {
    setError(null); setSaved(false)
    const depositPaise = parseRupeesToPaise(v.deposit || '0')
    if (depositPaise === null) { setError('Enter the deposit in rupees, e.g. 25,000'); return }
    const parsed = billingSettingsSchema.safeParse({
      legalName: v.legalName, gstin: v.gstin.trim() ? v.gstin : null, stateCode: v.stateCode, address: v.address.trim() ? v.address.trim() : null,
      placeOfSupplyMode: v.placeOfSupplyMode, consultationWindowDays: Number(v.consultationWindowDays), ipdDepositThresholdPaise: depositPaise,
      roomRentServiceId: v.roomRentServiceId ? Number(v.roomRentServiceId) : null, pharmacyGstRateBp: Number(v.pharmacyGstRateBp), pharmacyHsn: v.pharmacyHsn.trim(),
    })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const field = String(issue?.path[0] ?? '')
      setError(issue?.code === 'custom' || issue?.code === 'invalid_format' ? issue.message : `Check ${field || 'the form'}`)
      return
    }
    setBusy(true)
    const res = await sendJson('/api/billing/settings', 'PUT', parsed.data)
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setSaved(true)
    router.refresh()
  }

  return (
    <form className="grid gap-3 sm:grid-cols-2" noValidate onSubmit={(e) => { e.preventDefault(); void save() }}>
      <div className="sm:col-span-2">
        <label htmlFor={id('name')} className="mb-1 block text-xs font-medium text-muted-foreground">Legal name (as on GST registration)</label>
        <input id={id('name')} value={v.legalName} maxLength={200} onChange={set('legalName')} className={FIELD_CLASS} />
      </div>
      <div>
        <label htmlFor={id('gstin')} className="mb-1 block text-xs font-medium text-muted-foreground">GSTIN (leave blank if not registered)</label>
        <input id={id('gstin')} value={v.gstin} maxLength={15} onChange={set('gstin')} className={`${FIELD_CLASS} uppercase`} />
      </div>
      <div>
        <label htmlFor={id('state')} className="mb-1 block text-xs font-medium text-muted-foreground">State</label>
        <select id={id('state')} value={v.stateCode} onChange={set('stateCode')} className={FIELD_CLASS}>
          <option value="">Choose a state</option>
          {INDIAN_STATES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
        </select>
      </div>
      <div className="sm:col-span-2">
        <label htmlFor={id('addr')} className="mb-1 block text-xs font-medium text-muted-foreground">Address (printed on invoices)</label>
        <textarea id={id('addr')} value={v.address} maxLength={500} rows={2} onChange={set('address')} className={FIELD_CLASS} />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor={id('pos')} className="mb-1 block text-xs font-medium text-muted-foreground">Place of supply</label>
        <select id={id('pos')} value={v.placeOfSupplyMode} onChange={set('placeOfSupplyMode')} className={FIELD_CLASS}>
          <option value="location_of_service">{POS_LABEL.location_of_service}</option>
          <option value="recipient_state">{POS_LABEL.recipient_state}</option>
        </select>
      </div>
      <div>
        <label htmlFor={id('window')} className="mb-1 block text-xs font-medium text-muted-foreground">Consultation window (days before a procedure)</label>
        <input id={id('window')} type="number" min={1} max={365} value={v.consultationWindowDays} onChange={set('consultationWindowDays')} className={FIELD_CLASS} />
      </div>
      <div>
        <label htmlFor={id('deposit')} className="mb-1 block text-xs font-medium text-muted-foreground">IPD deposit before procedures (₹, 0 = none)</label>
        <input id={id('deposit')} inputMode="decimal" value={v.deposit} onChange={set('deposit')} className={FIELD_CLASS} />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor={id('room')} className="mb-1 block text-xs font-medium text-muted-foreground">Room-rent service</label>
        <select id={id('room')} value={v.roomRentServiceId} onChange={set('roomRentServiceId')} className={FIELD_CLASS}>
          <option value="">Not set (room rent cannot be posted)</option>
          {roomRentServices.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={id('pgst')} className="mb-1 block text-xs font-medium text-muted-foreground">Pharmacy GST rate</label>
        <select id={id('pgst')} value={v.pharmacyGstRateBp} onChange={set('pharmacyGstRateBp')} className={FIELD_CLASS}>
          {GST_RATES_BP.map((bp) => <option key={bp} value={bp}>{bpToPercent(bp)}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={id('phsn')} className="mb-1 block text-xs font-medium text-muted-foreground">Pharmacy HSN</label>
        <input id={id('phsn')} value={v.pharmacyHsn} inputMode="numeric" maxLength={8} onChange={set('pharmacyHsn')} className={FIELD_CLASS} />
      </div>
      <div className="flex items-center justify-end gap-3 sm:col-span-2">
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {saved && <p className="text-sm text-emerald-700 dark:text-emerald-300" aria-live="polite">Settings saved.</p>}
        <Button type="submit" disabled={busy}>Save settings</Button>
      </div>
    </form>
  )
}
