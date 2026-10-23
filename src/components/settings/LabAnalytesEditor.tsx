'use client'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import { DEMO_REFERENCE_RANGE_NOTE, rangeText, type AnalyteRange, type AnalyteValueType } from '@/lib/labs/analytes'
import type { AnalyteDefinitionInput } from '@/lib/labs/validation'
import type { AnalyteRecord } from '@/lib/queries/lab-analytes'

// WS4 T8 Settings → Lab setup → Analytes: a test's analytes, each with a nested table of age/sex
// reference ranges. Saving replaces the whole list (an analyte with results is kept inactive).
// Fields are held as text while editing and converted on save; the server re-validates everything.

const INPUT = 'w-full rounded-md border border-border px-2 py-1 text-xs'
const NUM_INPUT = 'w-20 rounded-md border border-border px-2 py-1 text-xs'

interface RangeDraft { sex: AnalyteRange['sex']; ageMinDays: string; ageMaxDays: string; normalLow: string; normalHigh: string; criticalLow: string; criticalHigh: string; displayText: string }
interface AnalyteDraft {
  key: number; code: string; name: string; unit: string; valueType: AnalyteValueType; decimals: string; loincCode: string
  options: string; abnormalOptions: string; criticalOptions: string; ranges: RangeDraft[]
}

let nextKey = 1
const str = (v: number | string | null) => (v === null ? '' : String(v))
const list = (v: string[] | null) => (v ?? []).join(', ')
const RANGE_FIELD_LABEL = {
  ageMinDays: 'Age from (days)', ageMaxDays: 'Age below (days)', criticalLow: 'Critical low', normalLow: 'Normal low', normalHigh: 'Normal high', criticalHigh: 'Critical high',
} as const
const EMPTY_RANGE: RangeDraft = { sex: 'any', ageMinDays: '0', ageMaxDays: '', normalLow: '', normalHigh: '', criticalLow: '', criticalHigh: '', displayText: '' }

function toDraft(a: AnalyteRecord): AnalyteDraft {
  return {
    key: nextKey++, code: a.code, name: a.name, unit: a.unit ?? '', valueType: a.valueType, decimals: str(a.decimals), loincCode: a.loincCode ?? '',
    options: list(a.options), abnormalOptions: list(a.abnormalOptions), criticalOptions: list(a.criticalOptions),
    ranges: a.ranges.map((r) => ({
      sex: r.sex, ageMinDays: String(r.ageMinDays), ageMaxDays: str(r.ageMaxDays), normalLow: str(r.normalLow), normalHigh: str(r.normalHigh),
      criticalLow: str(r.criticalLow), criticalHigh: str(r.criticalHigh), displayText: r.displayText ?? '',
    })),
  }
}

const textOrNull = (s: string) => (s.trim() === '' ? null : s.trim())
const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s))
const listOrNull = (s: string) => {
  const items = s.split(',').map((x) => x.trim()).filter(Boolean)
  return items.length === 0 ? null : items
}

function toInput(d: AnalyteDraft): AnalyteDefinitionInput {
  return {
    code: d.code.trim().toUpperCase(), name: d.name.trim(), unit: textOrNull(d.unit), valueType: d.valueType, decimals: numOrNull(d.decimals),
    loincCode: textOrNull(d.loincCode), options: listOrNull(d.options), abnormalOptions: listOrNull(d.abnormalOptions), criticalOptions: listOrNull(d.criticalOptions),
    ranges: d.ranges.map((r) => ({
      sex: r.sex, ageMinDays: Number(r.ageMinDays || '0'), ageMaxDays: numOrNull(r.ageMaxDays), normalLow: numOrNull(r.normalLow), normalHigh: numOrNull(r.normalHigh),
      criticalLow: numOrNull(r.criticalLow), criticalHigh: numOrNull(r.criticalHigh), displayText: textOrNull(r.displayText),
    })),
  }
}

function previewRange(r: RangeDraft, unit: string): string | null {
  const n = (s: string) => (s.trim() === '' || Number.isNaN(Number(s)) ? null : Number(s))
  return rangeText({
    sex: r.sex, ageMinDays: 0, ageMaxDays: null, normalLow: n(r.normalLow), normalHigh: n(r.normalHigh), criticalLow: null, criticalHigh: null, displayText: textOrNull(r.displayText),
  }, textOrNull(unit))
}

export function LabAnalytesEditor({ labTestId, testName, onClose }: { labTestId: number; testName: string; onClose: () => void }) {
  const [drafts, setDrafts] = useState<AnalyteDraft[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let live = true
    fetchJson<{ analytes: AnalyteRecord[] }>(`/api/lab-tests/${labTestId}/analytes`).then((res) => {
      if (!live) return
      if (res.ok) setDrafts(res.data.analytes.map(toDraft))
      else setError(res.error)
    })
    return () => { live = false }
  }, [labTestId])

  const update = (key: number, patch: Partial<AnalyteDraft>) =>
    setDrafts((ds) => ds && ds.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  const updateRange = (key: number, i: number, patch: Partial<RangeDraft>) =>
    setDrafts((ds) => ds && ds.map((d) => (d.key === key ? { ...d, ranges: d.ranges.map((r, j) => (j === i ? { ...r, ...patch } : r)) } : d)))

  async function save() {
    if (!drafts) return
    setError(null)
    setSaved(false)
    setSaving(true)
    const res = await sendJson<{ analytes: AnalyteRecord[] }>(`/api/lab-tests/${labTestId}/analytes`, 'PUT', { analytes: drafts.map(toInput) })
    setSaving(false)
    if (!res.ok) { setError(res.error); return }
    setDrafts(res.data.analytes.map(toDraft))
    setSaved(true)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Analytes: {testName}</DialogTitle>
        </DialogHeader>
        {drafts === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
        {drafts !== null && drafts.length > 0 && <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">{DEMO_REFERENCE_RANGE_NOTE}</p>}
        {drafts !== null && drafts.length === 0 && (
          <p className="text-sm text-muted-foreground">No analytes: results for this test are entered as a single value.</p>
        )}
        {drafts?.map((d, idx) => (
          <fieldset key={d.key} className="space-y-2 rounded-md border border-border p-3">
            <legend className="px-1 text-xs font-semibold text-muted-foreground">Analyte {idx + 1}</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
              <label className="text-xs">Code<input aria-label="Analyte code" className={INPUT} value={d.code} maxLength={16} onChange={(e) => update(d.key, { code: e.target.value })} /></label>
              <label className="text-xs sm:col-span-2">Name<input aria-label="Analyte name" className={INPUT} value={d.name} maxLength={80} onChange={(e) => update(d.key, { name: e.target.value })} /></label>
              <label className="text-xs">Unit<input aria-label="Unit" className={INPUT} value={d.unit} maxLength={20} onChange={(e) => update(d.key, { unit: e.target.value })} /></label>
              <label className="text-xs">Type
                <select aria-label="Value type" className={INPUT} value={d.valueType} onChange={(e) => update(d.key, { valueType: e.target.value as AnalyteValueType })}>
                  <option value="numeric">Number</option>
                  <option value="option">Choice</option>
                  <option value="text">Text</option>
                </select>
              </label>
              <label className="text-xs">Decimals<input aria-label="Decimals" inputMode="numeric" className={INPUT} value={d.decimals} onChange={(e) => update(d.key, { decimals: e.target.value })} /></label>
              <label className="text-xs">LOINC<input aria-label="LOINC code" className={INPUT} value={d.loincCode} maxLength={20} onChange={(e) => update(d.key, { loincCode: e.target.value })} /></label>
              {d.valueType === 'option' && (
                <>
                  <label className="text-xs sm:col-span-2">Choices (comma separated)<input aria-label="Choices" className={INPUT} value={d.options} onChange={(e) => update(d.key, { options: e.target.value })} /></label>
                  <label className="text-xs">Abnormal choices<input aria-label="Abnormal choices" className={INPUT} value={d.abnormalOptions} onChange={(e) => update(d.key, { abnormalOptions: e.target.value })} /></label>
                  <label className="text-xs">Critical choices<input aria-label="Critical choices" className={INPUT} value={d.criticalOptions} onChange={(e) => update(d.key, { criticalOptions: e.target.value })} /></label>
                </>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="pr-2 font-semibold">Sex</th>
                    <th className="pr-2 font-semibold">Age from (days)</th>
                    <th className="pr-2 font-semibold">Age below (days)</th>
                    <th className="pr-2 font-semibold">Critical low</th>
                    <th className="pr-2 font-semibold">Normal low</th>
                    <th className="pr-2 font-semibold">Normal high</th>
                    <th className="pr-2 font-semibold">Critical high</th>
                    <th className="pr-2 font-semibold">Display text</th>
                    <th className="pr-2 font-semibold">Shows as</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.ranges.map((r, i) => (
                    <tr key={i}>
                      <td className="pr-2 py-1">
                        <select aria-label="Range sex" className={NUM_INPUT} value={r.sex} onChange={(e) => updateRange(d.key, i, { sex: e.target.value as RangeDraft['sex'] })}>
                          <option value="any">Any</option>
                          <option value="male">Male</option>
                          <option value="female">Female</option>
                        </select>
                      </td>
                      {(['ageMinDays', 'ageMaxDays', 'criticalLow', 'normalLow', 'normalHigh', 'criticalHigh'] as const).map((f) => (
                        <td key={f} className="pr-2 py-1">
                          <input aria-label={RANGE_FIELD_LABEL[f]} inputMode="decimal" className={NUM_INPUT} value={r[f]} onChange={(e) => updateRange(d.key, i, { [f]: e.target.value })} />
                        </td>
                      ))}
                      <td className="pr-2 py-1"><input aria-label="Display text" className={NUM_INPUT} value={r.displayText} maxLength={60} onChange={(e) => updateRange(d.key, i, { displayText: e.target.value })} /></td>
                      <td className="pr-2 py-1 text-muted-foreground">{previewRange(r, d.unit) ?? '—'}</td>
                      <td className="py-1">
                        <button type="button" className="text-destructive hover:underline" onClick={() => update(d.key, { ranges: d.ranges.filter((_, j) => j !== i) })}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-3 text-xs">
              <button type="button" className="text-primary hover:underline" onClick={() => update(d.key, { ranges: [...d.ranges, { ...EMPTY_RANGE }] })}>Add range</button>
              <button type="button" className="text-destructive hover:underline" onClick={() => setDrafts((ds) => ds && ds.filter((x) => x.key !== d.key))}>Remove analyte</button>
            </div>
          </fieldset>
        ))}
        {drafts !== null && (
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => setDrafts((ds) => [...(ds ?? []), { key: nextKey++, code: '', name: '', unit: '', valueType: 'numeric', decimals: '', loincCode: '', options: '', abnormalOptions: '', criticalOptions: '', ranges: [] }])}
          >
            Add analyte
          </button>
        )}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        {saved && <p role="status" className="text-xs text-muted-foreground">Saved.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={save} disabled={saving || drafts === null}>{saving ? 'Saving…' : 'Save analytes'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
