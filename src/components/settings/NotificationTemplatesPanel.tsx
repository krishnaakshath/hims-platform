'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'
import type { NotificationTemplateKey } from '@/lib/notify/templates'

// Foundations T8 Settings → Notifications (admin only): which channels each patient notice uses,
// plus the India DLT template id (SMS) and the approved WhatsApp template name. Provider
// credentials are never shown or edited here; they come from the server environment.

type DeliveryChannel = 'sms' | 'whatsapp' | 'email' | 'in_app'
const CHANNELS: { key: DeliveryChannel; label: string }[] = [
  { key: 'sms', label: 'SMS' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'email', label: 'Email' },
  { key: 'in_app', label: 'In-app' },
]
const INPUT = 'w-full rounded-md border border-border px-2 py-1 text-sm'

export interface TemplateConfigRow {
  templateKey: NotificationTemplateKey
  saved: boolean
  channels: DeliveryChannel[]
  dltTemplateId: string | null
  whatsappTemplateName: string | null
}

const labelOf = (key: string) => key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ')

function Row({ config }: { config: TemplateConfigRow }) {
  const router = useRouter()
  const label = labelOf(config.templateKey)
  const [channels, setChannels] = useState<DeliveryChannel[]>(config.channels)
  const [dlt, setDlt] = useState(config.dltTemplateId ?? '')
  const [wa, setWa] = useState(config.whatsappTemplateName ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const toggle = (c: DeliveryChannel) => {
    setSaved(false)
    setChannels((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]))
  }

  async function save() {
    setBusy(true)
    setError(null)
    setSaved(false)
    const ordered = CHANNELS.map((c) => c.key).filter((c) => channels.includes(c))
    const res = await sendJson('/api/settings/notification-templates', 'PUT', {
      templateKey: config.templateKey,
      channels: ordered,
      dltTemplateId: dlt.trim() || null,
      whatsappTemplateName: wa.trim() || null,
    })
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setSaved(true)
    router.refresh()
  }

  return (
    <tr aria-label={label} className="border-t border-border align-top">
      <th scope="row" className="py-2 pr-3 text-left font-medium text-foreground">
        {label}
        {!config.saved && <span className="block text-xs font-normal text-muted-foreground">Default</span>}
      </th>
      {CHANNELS.map((c) => (
        <td key={c.key} className="py-2 pr-3 text-center">
          <input type="checkbox" aria-label={`${label}: ${c.label}`} checked={channels.includes(c.key)} onChange={() => toggle(c.key)} />
        </td>
      ))}
      <td className="py-2 pr-3">
        <input className={INPUT} aria-label={`${label}: DLT template id`} inputMode="numeric" value={dlt} onChange={(e) => { setSaved(false); setDlt(e.target.value) }} />
      </td>
      <td className="py-2 pr-3">
        <input className={INPUT} aria-label={`${label}: WhatsApp template name`} value={wa} onChange={(e) => { setSaved(false); setWa(e.target.value) }} />
      </td>
      <td className="py-2">
        <button type="button" onClick={save} disabled={busy} aria-label={`Save ${label}`} className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50">
          Save
        </button>
        {saved && <p role="status" className="mt-1 text-xs text-muted-foreground">Saved</p>}
        {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
      </td>
    </tr>
  )
}

export function NotificationTemplatesPanel({ configs, configured }: { configs: TemplateConfigRow[]; configured: Record<DeliveryChannel, boolean> }) {
  return (
    <div className="space-y-3">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {CHANNELS.map((c) => (
          <li key={c.key}>{c.label}: {configured[c.key] ? 'set up' : 'not set up (notices are logged, not sent)'}</li>
        ))}
      </ul>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-1 pr-3 text-left">Template</th>
              {CHANNELS.map((c) => <th key={c.key} scope="col" className="py-1 pr-3">{c.label}</th>)}
              <th scope="col" className="py-1 pr-3 text-left">DLT template id</th>
              <th scope="col" className="py-1 pr-3 text-left">WhatsApp template</th>
              <th scope="col" className="py-1"><span className="sr-only">Save</span></th>
            </tr>
          </thead>
          <tbody>
            {configs.map((c) => <Row key={c.templateKey} config={c} />)}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">Notices carry only the hospital name, dates and times. Opted-out channels are skipped for that patient.</p>
    </div>
  )
}
