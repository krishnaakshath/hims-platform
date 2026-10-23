'use client'
import { createContext, useContext, useState, type ReactNode } from 'react'

export const WORKSPACE_TABS = [
  { key: 'vitals', label: 'Vitals' },
  { key: 'history', label: 'History' },
  { key: 'diagnosis', label: 'Diagnosis' },
  { key: 'rx', label: 'Rx' },
  { key: 'orders', label: 'Orders' },
  { key: 'notes', label: 'Notes' },
] as const
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number]['key']

// WS1 T5: lets the footer (CompleteVisitBar) jump to a tab, e.g. "Add diagnosis" or "Sign note".
const SelectTabContext = createContext<(tab: WorkspaceTab) => void>(() => {})
export function useSelectWorkspaceTab(): (tab: WorkspaceTab) => void {
  return useContext(SelectTabContext)
}

// WS1 T3: the workspace tabs. Every panel stays mounted (hidden when not selected) so a half-typed
// form survives a tab switch. `footer` is a sticky slot under the panels (Complete visit, later).
export function WorkspaceShell({ panels, footer, initialTab = 'vitals' }: { panels: Record<WorkspaceTab, ReactNode>; footer?: ReactNode; initialTab?: WorkspaceTab }) {
  const [tab, setTab] = useState<WorkspaceTab>(initialTab)
  return (
    <SelectTabContext.Provider value={setTab}>
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Consultation" className="flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1">
        {WORKSPACE_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`ws-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`ws-panel-${t.key}`}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${tab === t.key ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {WORKSPACE_TABS.map((t) => (
        <div key={t.key} role="tabpanel" id={`ws-panel-${t.key}`} aria-labelledby={`ws-tab-${t.key}`} hidden={tab !== t.key}
          className="rounded-lg border border-border bg-card p-5 shadow-sm">
          {panels[t.key]}
        </div>
      ))}
      {footer && <div className="sticky bottom-0 z-10 rounded-lg border border-border bg-card px-5 py-3 shadow-md">{footer}</div>}
    </div>
    </SelectTabContext.Provider>
  )
}
