'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { SAMPLE_CONTAINERS, SAMPLE_CONTAINER_LABEL, SAMPLE_TYPES, SAMPLE_TYPE_LABEL } from '@/lib/labs/catalog'
import type { LabTestSetupRow } from '@/lib/queries/lab-setup'

const SELECT = 'rounded-md border border-border px-2 py-1 text-xs'

export interface InvestigationServiceOption { id: number; code: string; name: string }

type Field = 'sampleType' | 'container' | 'serviceId'

// SP5 Settings → Lab setup: each lab test's sample type, tube and the SP2 tariff service that
// prices it (Ruling 11). An unmapped test is still orderable; its quote says "unmapped".
export function LabTestSetupPanel({ tests, services, isAdmin }: { tests: LabTestSetupRow[]; services: InvestigationServiceOption[]; isAdmin: boolean }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<number | null>(null)

  async function save(t: LabTestSetupRow, field: Field, raw: string) {
    setError(null)
    setSavingId(t.id)
    const value = raw === '' ? null : field === 'serviceId' ? Number(raw) : raw
    try {
      const res = await fetch(`/api/lab-tests/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(res.status === 400 && body.error ? `${t.name}: ${body.error}` : `Could not update ${t.name}.`)
        return
      }
      router.refresh()
    } finally {
      setSavingId(null)
    }
  }

  if (tests.length === 0) return <p className="text-sm text-muted-foreground">No lab tests in the catalogue.</p>

  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="py-2 pr-3 font-semibold">Test</th>
              <th className="py-2 pr-3 font-semibold">Sample</th>
              <th className="py-2 pr-3 font-semibold">Tube</th>
              <th className="py-2 font-semibold">Tariff service</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {tests.map((t) => (
              <tr key={t.id} aria-busy={savingId === t.id || undefined}>
                <td className="py-2 pr-3">
                  <span className="font-medium text-foreground">{t.name}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{t.code}</span>
                  {t.category === 'imaging' && <span className="ml-2 text-xs text-muted-foreground">Imaging</span>}
                </td>
                {isAdmin ? (
                  <>
                    <td className="py-2 pr-3">
                      <select aria-label={`Sample type for ${t.name}`} value={t.sampleType ?? ''} disabled={savingId === t.id} onChange={(e) => save(t, 'sampleType', e.target.value)} className={SELECT}>
                        <option value="">Not set</option>
                        {SAMPLE_TYPES.map((s) => <option key={s} value={s}>{SAMPLE_TYPE_LABEL[s]}</option>)}
                      </select>
                    </td>
                    <td className="py-2 pr-3">
                      <select aria-label={`Tube for ${t.name}`} value={t.container ?? ''} disabled={savingId === t.id} onChange={(e) => save(t, 'container', e.target.value)} className={SELECT}>
                        <option value="">Not set</option>
                        {SAMPLE_CONTAINERS.map((c) => <option key={c} value={c}>{SAMPLE_CONTAINER_LABEL[c]}</option>)}
                      </select>
                    </td>
                    <td className="py-2">
                      <select aria-label={`Tariff service for ${t.name}`} value={t.serviceId ?? ''} disabled={savingId === t.id} onChange={(e) => save(t, 'serviceId', e.target.value)} className={SELECT}>
                        <option value="">Not mapped</option>
                        {/* Keep a mapped service selectable even when it is outside the loaded list. */}
                        {t.serviceId !== null && !services.some((s) => s.id === t.serviceId) && (
                          <option value={t.serviceId}>{t.serviceCode ?? ''} {t.serviceName ?? ''}</option>
                        )}
                        {services.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
                      </select>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">{t.sampleType ? SAMPLE_TYPE_LABEL[t.sampleType] : 'Not set'}</td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">{t.container ? SAMPLE_CONTAINER_LABEL[t.container] : 'Not set'}</td>
                    <td className="py-2 text-xs text-muted-foreground">{t.serviceCode ? `${t.serviceCode} · ${t.serviceName ?? ''}` : 'Not mapped'}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
