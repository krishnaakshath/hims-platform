'use client'
import { useState } from 'react'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import { useRouter } from 'next/navigation'
import { SAMPLE_CONTAINERS, SAMPLE_CONTAINER_LABEL, SAMPLE_TYPES, SAMPLE_TYPE_LABEL } from '@/lib/labs/catalog'
import type { LabTestSetupRow } from '@/lib/queries/lab-setup'
import { LabAnalytesEditor } from '@/components/settings/LabAnalytesEditor' // WS4 T8
// WS4 T13
import type { TariffTestCandidate } from '@/lib/queries/lab-catalogue'
import { formatPaise } from '@/lib/money'
import { LAB_TESTS_FROM_TARIFF_MAX } from '@/lib/labs/validation'
// end WS4 T13

const SELECT = 'rounded-md border border-border px-2 py-1 text-xs'

export interface InvestigationServiceOption { id: number; code: string; name: string }

type Field = 'sampleType' | 'container' | 'serviceId'

// SP5 Settings → Lab setup: each lab test's sample type, tube and the SP2 tariff service that
// prices it (Ruling 11). Foundations T10: an unmapped test cannot be ordered, so those are listed first.
export function LabTestSetupPanel({ tests, services, isAdmin }: { tests: LabTestSetupRow[]; services: InvestigationServiceOption[]; isAdmin: boolean }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [analytesFor, setAnalytesFor] = useState<LabTestSetupRow | null>(null) // WS4 T8

  async function save(t: LabTestSetupRow, field: Field, raw: string) {
    setError(null)
    setSavingId(t.id)
    const value = raw === '' ? null : field === 'serviceId' ? Number(raw) : raw
    const res = await sendJson(`/api/lab-tests/${t.id}`, 'PATCH', { [field]: value })
    setSavingId(null)
    if (!res.ok) { setError(`${t.name}: ${res.error}`); return }
    router.refresh()
  }

  // Unmapped first (stable within each group: the list arrives sorted by name).
  const ordered = [...tests.filter((t) => t.serviceId === null), ...tests.filter((t) => t.serviceId !== null)]
  if (tests.length === 0) {
    return (
      <div className="space-y-3">
        {isAdmin && <AddFromTariff />}
        <p className="text-sm text-muted-foreground">No lab tests in the catalogue.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {isAdmin && <AddFromTariff />}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {analytesFor && <LabAnalytesEditor labTestId={analytesFor.id} testName={analytesFor.name} onClose={() => setAnalytesFor(null)} />}
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
            {ordered.map((t) => (
              <tr key={t.id} aria-busy={savingId === t.id || undefined}>
                <td className="py-2 pr-3">
                  <span className="font-medium text-foreground">{t.name}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{t.code}</span>
                  {t.category === 'imaging' && <span className="ml-2 text-xs text-muted-foreground">Imaging</span>}
                  {/* WS4 T8: analytes and reference ranges (setup roles only). */}
                  {isAdmin && t.category === 'lab' && (
                    <button type="button" className="ml-2 text-xs text-primary hover:underline" aria-label={`Analytes for ${t.name}`} onClick={() => setAnalytesFor(t)}>Analytes</button>
                  )}
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
                      <select aria-label={`Tariff service for ${t.name}`} title={t.serviceId === null ? 'No price: map this test so it can be ordered' : undefined} value={t.serviceId ?? ''} disabled={savingId === t.id} onChange={(e) => save(t, 'serviceId', e.target.value)} className={SELECT}>
                        <option value="">{t.serviceId === null ? 'Map…' : 'Unmap'}</option>
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
                    <td className="py-2 text-xs text-muted-foreground">{t.serviceCode ? `${t.serviceCode} · ${t.serviceName ?? ''}` : 'Not mapped: cannot be ordered'}</td>
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

const CATEGORY_LABEL: Record<TariffTestCandidate['category'], string> = {
  investigation_lab: 'Lab',
  investigation_imaging: 'Imaging',
  procedure: 'Procedure',
}

// WS4 T13 (spec 3.6 item 27): every lab test comes from a tariff service. Lists the active lab,
// imaging and procedure services that have no test yet; the picked ones become tests (code, name and
// price from the tariff). A procedure such as ECG becomes an imaging / diagnostics test.
export function AddFromTariff() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [candidates, setCandidates] = useState<TariffTestCandidate[]>([])
  const [picked, setPicked] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function load() {
    setError(null)
    setLoading(true)
    const res = await fetchJson<{ candidates: TariffTestCandidate[] }>('/api/lab-tests/from-tariff')
    setLoading(false)
    if (!res.ok) { setError(res.error); return }
    setCandidates(res.data?.candidates ?? [])
    setPicked([])
  }

  async function show() {
    setNotice(null)
    setOpen(true)
    await load()
  }

  function toggle(id: number) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  }

  async function create() {
    setError(null)
    setSaving(true)
    const res = await sendJson<{ created: { id: number }[] }>('/api/lab-tests/from-tariff', 'POST', { serviceIds: picked })
    setSaving(false)
    if (!res.ok) { setError(res.error); return }
    const n = res.data?.created.length ?? 0
    setNotice(`${n} test${n === 1 ? '' : 's'} added to the catalogue.`)
    router.refresh()
    await load()
  }

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <button type="button" onClick={show} className="rounded-md border border-border px-3 py-1 text-sm hover:bg-secondary">Add from tariff</button>
        {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
      </div>
    )
  }

  const tooMany = picked.length > LAB_TESTS_FROM_TARIFF_MAX
  return (
    <section aria-label="Add from tariff" className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Add from tariff</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-muted-foreground hover:underline">Close</button>
      </div>
      <p className="text-xs text-muted-foreground">Active lab, imaging and procedure services that have no lab test yet. Each picked service becomes one orderable test priced by its tariff.</p>
      {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading services…</p>
      ) : candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">Every active lab, imaging and procedure service already has a test.</p>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {candidates.map((c) => (
            <li key={c.serviceId}>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={picked.includes(c.serviceId)} onChange={() => toggle(c.serviceId)} />
                <span className="font-mono text-xs text-muted-foreground">{c.code}</span>
                <span>{c.name}</span>
                <span className="text-xs text-muted-foreground">{`${CATEGORY_LABEL[c.category]} · ${c.departmentName}`}</span>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">{c.basePaise === null ? 'No current rate' : formatPaise(c.basePaise)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {tooMany && <p className="text-xs text-warning">{`Pick at most ${LAB_TESTS_FROM_TARIFF_MAX} services at a time.`}</p>}
      <div className="flex justify-end">
        <button type="button" disabled={picked.length === 0 || tooMany || saving} onClick={create}
          className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50">
          {picked.length === 0 ? 'Create tests' : `Create ${picked.length} test${picked.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </section>
  )
}
