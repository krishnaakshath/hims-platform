'use client'
// SP7 (ruling 7): the pre-auth reference field on charge capture. Lists the patient's approved
// pre-auths valid on the service date; free text is still allowed (the server checks it with the
// preauth_invalid rule).
import { useEffect, useState } from 'react'
import { fetchJson } from '@/lib/client-fetch'
import { formatPaise } from '@/lib/format'
import { formatIsoDate } from '@/lib/india-time'

interface Approved { id: number; preauthNumber: string; approvalReference: string; approvedPaise: number; validUntil: string }

export function PreauthPicker({ patientId, serviceDate, value, onChange, inputId, className }: {
  patientId: string; serviceDate: string; value: string; onChange: (v: string) => void; inputId: string; className?: string
}) {
  const [options, setOptions] = useState<Approved[]>([])
  useEffect(() => {
    let live = true
    const t = setTimeout(async () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) { if (live) setOptions([]); return }
      const r = await fetchJson<{ preauths: Approved[] }>(`/api/rcm/patients/${encodeURIComponent(patientId)}/approved-preauths?onDate=${serviceDate}`)
      if (live) setOptions(r.ok ? r.data.preauths : [])
    }, 0)
    return () => { live = false; clearTimeout(t) }
  }, [patientId, serviceDate])
  return (
    <div className="space-y-1">
      <input id={inputId} value={value} maxLength={40} onChange={(e) => onChange(e.target.value)} className={className} />
      {options.length > 0 && (
        <ul className="space-y-1 text-xs" aria-label="Approved pre-authorisations">
          {options.map((o) => (
            <li key={o.id}>
              <button type="button" className={`rounded border px-2 py-1 hover:bg-muted ${value === o.approvalReference ? 'border-primary' : 'border-border'}`} onClick={() => onChange(o.approvalReference)}>
                {o.preauthNumber} · {o.approvalReference} · {formatPaise(o.approvedPaise)} · valid to {formatIsoDate(o.validUntil)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
