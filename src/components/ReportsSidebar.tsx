'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'

interface ReportLeaf { href: string; label: string }
interface ReportGroup { label: string; leaves: ReportLeaf[] }

const GROUPS: ReportGroup[] = [
  { label: 'Patients', leaves: [{ href: '/reports/patients', label: 'All Patients' }] },
  { label: 'Appointments', leaves: [{ href: '/reports/appointments/all', label: 'All Appointments' }] },
  { label: 'Notes', leaves: [{ href: '/reports/notes/unsigned', label: 'Unsigned Notes' }] },
  { label: 'Encounters', leaves: [{ href: '/reports/encounters/all', label: 'All Encounters' }] },
  { label: 'Claims', leaves: [{ href: '/reports/claims/insurance-collections', label: 'Insurance Collections' }] },
]

export function ReportsSidebar() {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  return (
    <nav className="w-64 shrink-0 space-y-1 border-r border-border pr-4">
      {GROUPS.map((group) => {
        const isCollapsed = collapsed[group.label] ?? false
        const groupActive = group.leaves.some((l) => pathname === l.href)
        return (
          <div key={group.label}>
            <button
              onClick={() => setCollapsed((prev) => ({ ...prev, [group.label]: !isCollapsed }))}
              aria-expanded={!isCollapsed}
              className={`flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide ${groupActive ? 'text-primary' : 'text-muted-foreground'}`}
            >
              {group.label}
              <span aria-hidden="true">{isCollapsed ? '+' : '−'}</span>
            </button>
            {!isCollapsed && (
              <ul className="ml-2 space-y-0.5 border-l border-border pl-2">
                {group.leaves.map((leaf) => {
                  const active = pathname === leaf.href
                  return (
                    <li key={leaf.href}>
                      <Link
                        href={leaf.href}
                        aria-current={active ? 'page' : undefined}
                        className={`block rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
                      >
                        {leaf.label}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
    </nav>
  )
}
