'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, FileText, Pill, CalendarCheck, MessageSquare, Megaphone, ShieldCheck } from 'lucide-react'
import { BrandLogo } from '@/components/BrandLogo'

type Icon = React.ComponentType<{ className?: string }>

const ITEMS: { href: string; label: string; icon: Icon }[] = [
  { href: '/patient-portal', label: 'Overview', icon: LayoutDashboard },
  { href: '/patient-portal/forms', label: 'Forms', icon: FileText },
  { href: '/patient-portal/broadcasts', label: 'Announcements', icon: Megaphone },
  { href: '/patient-portal/medications', label: 'Medications', icon: Pill },
  { href: '/patient-portal/appointments', label: 'Appointments', icon: CalendarCheck },
  { href: '/patient-portal/messages', label: 'Messages', icon: MessageSquare },
  { href: '/patient-portal/security', label: 'Security', icon: ShieldCheck },
]

function isActive(pathname: string | null, href: string): boolean {
  if (href === '/patient-portal') return pathname === href
  return pathname === href || (pathname?.startsWith(`${href}/`) ?? false)
}

// Deliberately its own visual treatment, not the staff app's dark LeftNav --
// same reasoning as the patient login page: a patient's own portal should
// read as calm and consumer-facing, not an internal ops tool. Light ground,
// soft primary-tinted active state; keeps the app-wide rounded-full pill
// convention, just recolored for a light background.
export function PatientPortalSideNav() {
  const pathname = usePathname()

  return (
    <nav className="w-60 shrink-0 overflow-y-auto border-r border-border/60 bg-secondary/30 p-3">
      <div className="mb-4 px-2.5 py-2">
        <BrandLogo className="text-lg font-semibold tracking-tight text-foreground" />
      </div>
      <p className="mb-1.5 px-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">Patient Portal</p>
      <ul className="space-y-0.5">
        {ITEMS.map((item) => {
          const active = isActive(pathname, item.href)
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2.5 rounded-full py-2 pe-3 ps-2.5 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-primary/10 font-semibold text-primary'
                    : 'text-muted-foreground hover:bg-white hover:text-foreground'
                }`}
              >
                <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
