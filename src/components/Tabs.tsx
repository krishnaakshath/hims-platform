'use client'
import { useState, type ReactNode } from 'react'

export interface TabDef {
  id: string
  label: ReactNode
  content: ReactNode
}

export function Tabs({ tabs }: { tabs: TabDef[] }) {
  const [active, setActive] = useState(tabs[0]?.id)
  return (
    <div>
      <div className="mb-4 flex items-center gap-1 overflow-x-auto rounded-lg border border-primary/10 bg-card/80 p-1 text-sm backdrop-blur-sm">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            aria-current={active === t.id ? 'page' : undefined}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 font-medium transition-colors ${active === t.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} hidden={active !== t.id}>
          {t.content}
        </div>
      ))}
    </div>
  )
}
