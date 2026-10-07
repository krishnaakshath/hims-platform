'use client'
import { useState } from 'react'
import { sendJson } from '@/components/tariff/api'
import type { ChargeRuleDefinition, RuleSeverity } from '@/lib/billing/charge-rules'

export type RuleRowView = ChargeRuleDefinition & { enabled: boolean; severity: RuleSeverity | null; effectiveSeverity: RuleSeverity }
const SEVERITY_LABEL: Record<RuleSeverity, string> = { block: 'Blocks', warn: 'Warns' }

/**
 * SP4: the charge rules with this hospital's configuration. Only configurable rules can change, and only
 * for BILLING_CONFIG_ROLES (`editable`); billing sees them read-only.
 */
export function RuleConfigTable({ rows: initial, editable }: { rows: RuleRowView[]; editable: boolean }) {
  const [rows, setRows] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  async function save(row: RuleRowView, patch: { enabled?: boolean; severity?: RuleSeverity | null }) {
    const next = { enabled: patch.enabled ?? row.enabled, severity: patch.severity !== undefined ? patch.severity : row.severity }
    setError(null); setSaved(null)
    const res = await sendJson(`/api/billing/rules/${row.code}`, 'PUT', next)
    if (!res.ok) { setError(res.error); return }
    setRows((rs) => rs.map((r) => (r.code === row.code ? { ...r, ...next, effectiveSeverity: next.severity ?? r.defaultSeverity } : r)))
    setSaved(row.label)
  }

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Rule</th>
              <th className="px-3 py-2">Default</th>
              <th className="px-3 py-2">In effect</th>
              <th className="px-3 py-2">Enabled</th>
              <th className="px-3 py-2">Severity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const canEdit = editable && r.configurable
              return (
                <tr key={r.code} className="border-t border-border">
                  <td className="px-3 py-2">
                    <span className="font-medium">{r.label}</span>
                    <span className="block text-xs text-muted-foreground">{r.configurable ? (r.overridable ? 'Billing staff may override with a reason' : 'Cannot be overridden on a charge') : 'Always on'}</span>
                  </td>
                  <td className="px-3 py-2">{SEVERITY_LABEL[r.defaultSeverity]}</td>
                  <td className="px-3 py-2">{r.enabled ? SEVERITY_LABEL[r.effectiveSeverity] : 'Off'}</td>
                  <td className="px-3 py-2">
                    {canEdit
                      ? <input type="checkbox" aria-label={`Enabled: ${r.label}`} checked={r.enabled} onChange={(e) => void save(r, { enabled: e.target.checked })} />
                      : <span>{r.enabled ? 'Yes' : 'No'}</span>}
                  </td>
                  <td className="px-3 py-2">
                    {canEdit ? (
                      <select aria-label={`Severity: ${r.label}`} value={r.severity ?? ''} onChange={(e) => void save(r, { severity: (e.target.value || null) as RuleSeverity | null })}
                        className="rounded-md border border-border bg-background px-2 py-1 text-sm">
                        <option value="">Default ({SEVERITY_LABEL[r.defaultSeverity].toLowerCase()})</option>
                        <option value="block">Blocks</option>
                        <option value="warn">Warns</option>
                      </select>
                    ) : <span>{r.severity ? SEVERITY_LABEL[r.severity] : 'Default'}</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {saved && <p className="text-sm text-muted-foreground" aria-live="polite">Saved: {saved}</p>}
    </div>
  )
}
