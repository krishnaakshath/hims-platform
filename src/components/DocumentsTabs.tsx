'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/documents', label: 'Documents' },
  { href: '/documents/fax-history', label: 'Fax History' },
]

// Fax History is admin/crc only (its page redirects everyone else), so the
// tab is hidden for pi and frontdesk rather than left as a dead link.
export function DocumentsTabs({ showFaxHistory = true }: { showFaxHistory?: boolean }) {
  const pathname = usePathname()
  return (
    <div className="flex gap-1 border-b border-border">
      {TABS.filter((tab) => showFaxHistory || tab.href !== '/documents/fax-history').map((tab) => {
        const active = pathname === tab.href
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {tab.label}
          </Link>
        )
      })}
    </div>
  )
}
