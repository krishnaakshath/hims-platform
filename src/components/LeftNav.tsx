'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import {
  LayoutDashboard, Stethoscope, Users, ClipboardList, FlaskConical,
  Calendar, FileText, FileSignature, MessageSquare, Wallet, Receipt, ShieldCheck, HandCoins,
  FileBarChart, TrendingUp, BarChart3, CreditCard, FileBarChart2, FolderOpen,
  Megaphone, Star, Activity, Settings, ChevronDown, ChevronRight, History,
  ClipboardCheck, ListChecks, BedDouble, Pill, TestTube2, IdCard, CalendarClock, Search,
  DollarSign, ScrollText, Tags, CalendarSync,
  House, Route, // SP5
  BookOpenCheck, FileCode2, // SP6
  UserCircle2, Calculator,
} from 'lucide-react'
import type { Role } from '@/lib/auth'
import { FOLLOW_UP_WORKLIST_ROLES } from '@/lib/role-policy'
import { ACCOUNT_ROLES, TARIFF_LOOKUP_ROLES } from '@/lib/role-policy' // Wave B
import { COLLECTOR_ROUTE_ROLES } from '@/lib/role-policy' // SP5
import { BrandLogo } from '@/components/BrandLogo'
import { useLiveNavBadges } from '@/components/useLiveNavBadges'

type Icon = React.ComponentType<{ className?: string }>

// Role-scoped navigation. Each role sees only the routes relevant to their
// job. This list is the source of truth that nav-role-enforcement tests
// derive server-side gate assertions from: a restricted entry here without
// a matching PAGE_GATES row will fail that suite.
//
// Per RBAC spec:
//  frontdesk  — check-in, assignments, beds, booking, home-collection booking (no lab results); NO billing, NO labs, NO messages, NO trials, NO staff
//  billing    — billing section only; NO clinical routes whatsoever
//  pharmacy   — pharmacy routes + Messages (to confirm a dispense with the prescriber); NO patients page, NO labs, NO staff
//  pi/doctor  — clinical workflow: My Patients, Patients, Calendar, Client Forms, Labs, Staff directory (view-only); NO billing
//  crc/admin  — full operational access

export const NAV_ITEMS: { href: string; label: string; icon: Icon; roles?: Role[] }[] = [
  // Visible to all roles that reach a dashboard
  { href: '/', label: 'Home', icon: LayoutDashboard },

  // Doctor / PI — clinical workflow
  { href: '/doctor', label: 'My Patients', icon: Stethoscope, roles: ['pi'] as Role[] },

  // Patient list — clinical roles only (not billing, not pharmacy)
  { href: '/patients', label: 'Patients', icon: Users, roles: ['crc', 'pi', 'admin', 'frontdesk'] as Role[] },

  // Admin/CRC/PI operational tools
  { href: '/workbook', label: 'Workbook', icon: ClipboardList, roles: ['admin', 'crc', 'pi'] as Role[] },

  // Trials & Protocols — clinical only
  { href: '/trials', label: 'Trials & Protocols', icon: FlaskConical, roles: ['crc', 'pi', 'admin'] as Role[] },

  // Calendar — clinical scheduling
  { href: '/calendar', label: 'Calendar', icon: Calendar, roles: ['crc', 'pi', 'admin', 'frontdesk'] as Role[] },

  // Form Templates — admin/crc/pi
  { href: '/forms', label: 'Form Templates', icon: FileText, roles: ['admin', 'crc', 'pi'] as Role[] },

  { href: '/consent-documents', label: 'Consent Documents', icon: ScrollText, roles: ['admin', 'crc', 'pi'] as Role[] },

  // Client Forms — clinical review (NOT billing, NOT pharmacy)
  { href: '/client-forms', label: 'Client Forms', icon: FileSignature, roles: ['crc', 'pi', 'admin'] as Role[] },

  // Front Desk specific flows
  { href: '/front-desk/check-in', label: 'Check-In', icon: ClipboardCheck, roles: ['frontdesk', 'admin', 'crc'] as Role[] },
  { href: '/front-desk/assignments', label: 'Assignments', icon: ListChecks, roles: ['frontdesk', 'admin', 'crc'] as Role[] },
  { href: '/front-desk/follow-ups', label: 'Follow-ups', icon: CalendarSync, roles: [...FOLLOW_UP_WORKLIST_ROLES] },
  { href: '/inpatient/beds', label: 'Beds / Wards', icon: BedDouble, roles: ['frontdesk', 'admin', 'crc', 'pi'] as Role[] },

  // Pharmacy — dedicated section; no full patient record access
  { href: '/pharmacy', label: 'Pharmacy', icon: Pill, roles: ['crc', 'pi', 'admin', 'pharmacy'] as Role[] },
  { href: '/pharmacy/patient-lookup', label: 'Patient Lookup', icon: Search, roles: ['pharmacy', 'admin'] as Role[] },
  // Pharmacy's own billing -- deliberately separate from the Billing role's
  // practice-wide revenue cycle (NAV_BILLING_ITEMS below): this covers only
  // charges generated from dispensed medications.
  { href: '/pharmacy/billing', label: 'Pharmacy Billing', icon: DollarSign, roles: ['pharmacy', 'admin'] as Role[] },

  // Labs — clinical + the dedicated Labs role only (NOT billing, NOT pharmacy,
  // NOT frontdesk -- front desk's job is registration/check-in, not lab
  // results; explicit product direction removed their prior worklist access).
  { href: '/labs', label: 'Labs', icon: TestTube2, roles: ['admin', 'crc', 'pi', 'labs'] as Role[] },
  // SP5: home-collection day board (HOME_COLLECTION_BOOKING_ROLES): booking logistics, no lab results.
  { href: '/home-collections', label: 'Home Collection', icon: House, roles: ['admin', 'frontdesk', 'labs'] as Role[] },
  // SP5: the collector's own route for the day (COLLECTOR_ROUTE_ROLES).
  { href: '/collections', label: 'My Route', icon: Route, roles: [...COLLECTOR_ROUTE_ROLES] },
  // end SP5

  // SP6: clinical coding worklist, workspace and report -- CODING_ROLES. The coder's only nav entry
  // besides Home; nothing clinical (patients, chart, notes) is shown to a coder.
  { href: '/coding', label: 'Coding', icon: FileCode2, roles: ['admin', 'coder'] as Role[] },
  // end SP6

  // Staff directory — admin/crc/pi (pi view-only; NOT frontdesk, NOT billing, NOT pharmacy, NOT labs)
  { href: '/staff', label: 'Staff', icon: IdCard, roles: ['crc', 'admin', 'pi'] as Role[] },

  // Booking requests — frontdesk / admin / crc
  { href: '/booking-requests', label: 'Booking Requests', icon: CalendarClock, roles: ['frontdesk', 'admin', 'crc', 'pi'] as Role[] },

  // Messages — clinical comms, plus pharmacy (to confirm a dispense with the
  // prescriber -- see PharmacyPatientLookup's own inline thread) (NOT billing, NOT frontdesk)
  { href: '/messages', label: 'Messages', icon: MessageSquare, roles: ['crc', 'pi', 'admin', 'pharmacy'] as Role[] },
]

// `demo: true` (Wave B P1-21) = a simulated feature, listed only when
// DEMO_FEATURES is on (src/lib/demo-features.ts) and labelled "Demo".
export const NAV_BILLING_ITEMS: { href: string; label: string; icon: Icon; demo?: boolean }[] = [
  // Wave B P0-01: the billing role's own home (its '/' redirects here, but
  // the billing-only nav hides the generic Home entry).
  { href: '/billing', label: 'Billing Home', icon: LayoutDashboard },
  { href: '/billing/ar-dashboard', label: 'A/R Dashboard', icon: TrendingUp },
  { href: '/billing/charges', label: 'Charges', icon: Receipt },
  { href: '/billing/insurance-collections', label: 'Insurance Collections', icon: ShieldCheck },
  { href: '/billing/patient-collections', label: 'Patient Collections', icon: HandCoins },
  { href: '/billing/statements', label: 'Statements', icon: FileBarChart },
  { href: '/billing/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/billing/pay', label: 'Virtual Card Payment', icon: CreditCard, demo: true },
]

export const NAV_TRAILING_ITEMS: { href: string; label: string; icon: Icon; roles?: Role[]; demo?: boolean }[] = [
  { href: '/reports', label: 'Reports', icon: FileBarChart2, roles: ['admin', 'crc'] as Role[] },
  { href: '/documents', label: 'Documents', icon: FolderOpen, roles: ['admin', 'crc', 'pi', 'frontdesk'] as Role[] },
  { href: '/broadcasts', label: 'Broadcasts', icon: Megaphone, roles: ['admin', 'crc'] as Role[], demo: true },
  { href: '/experience-surveys', label: 'Experience Surveys', icon: Star, roles: ['admin', 'crc'] as Role[], demo: true },
  { href: '/pipeline-dashboard', label: 'Pipeline Dashboard', icon: Activity, roles: ['admin', 'crc'] as Role[] },
  { href: '/audit-log', label: 'Audit Log', icon: History, roles: ['admin'] as Role[] },
  // Tariffs: service catalogue and price lists -- admin and billing (TARIFF_MANAGE_ROLES). crc/frontdesk only use the lookup API.
  { href: '/tariffs', label: 'Tariffs', icon: Tags, roles: ['admin', 'billing'] as Role[] },
  // SP6: code-system versions and import -- admin only (CODE_SYSTEM_ADMIN_ROLES).
  { href: '/coding/code-systems', label: 'Code Systems', icon: BookOpenCheck, roles: ['admin'] as Role[] },
  // end SP6
  // Settings: admin and the PI only, no other role -- explicit product direction.
  { href: '/settings', label: 'Settings', icon: Settings, roles: ['admin', 'pi'] as Role[] },
  // Wave B P1-05: price lookup (GET /api/tariff/resolve) -- TARIFF_LOOKUP_ROLES.
  { href: '/price-lookup', label: 'Price Lookup', icon: Calculator, roles: [...TARIFF_LOOKUP_ROLES] },
  // Wave B P1-01: own account (MFA, capabilities) -- every staff role.
  { href: '/account', label: 'My Account', icon: UserCircle2, roles: [...ACCOUNT_ROLES] },
]

function isActive(pathname: string | null, href: string): boolean {
  return pathname === href || (pathname?.startsWith(`${href}/`) ?? false)
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1 mt-5 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 first:mt-2">
      {children}
    </p>
  )
}

/** Count per nav href; `null` = badge intentionally suppressed (no pill). */
export type NavBadges = Partial<Record<string, number | null>>

function NavLink({ href, label, icon: Icon, active, badge, demo }: { href: string; label: string; icon: Icon; active: boolean; badge?: number; demo?: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
      {demo && <span className="shrink-0 rounded-full border border-current/30 px-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-80">Demo</span>}
      {badge !== undefined && badge > 0 && (
        <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold text-accent-foreground">{badge}</span>
      )}
    </Link>
  )
}

export const BILLING_ROLES: Role[] = ['admin', 'crc', 'billing']

export function LeftNav({ role, badges: initialBadges, demoFeatures = false }: { role: Role; badges?: NavBadges; demoFeatures?: boolean }) {
  const pathname = usePathname()
  // Server-computed counts are the initial state; the hook keeps them live.
  const badges = useLiveNavBadges(initialBadges)
  const items = NAV_ITEMS.filter((item) => !item.roles || item.roles.includes(role))
  const trailingItems = NAV_TRAILING_ITEMS.filter((item) => (!item.roles || item.roles.includes(role)) && (!item.demo || demoFeatures))
  const billingItems = NAV_BILLING_ITEMS.filter((item) => !item.demo || demoFeatures)
  const showBilling = BILLING_ROLES.includes(role)
  const billingActive = pathname?.startsWith('/billing') ?? false
  const [billingOpen, setBillingOpen] = useState(billingActive || role === 'billing')

  // Billing-only nav: only show the billing section, nothing else clinical
  const isBillingOnly = role === 'billing'

  return (
    <nav className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-card">
      {/* Logo / Wordmark */}
      <div className="flex h-14 shrink-0 items-center border-b border-border px-4">
        <BrandLogo className="text-base font-bold tracking-tight text-foreground" />
      </div>

      {/* min-h-0 is load-bearing: a flex item's default min-height is "auto"
          (its content's natural height), not 0 -- without it, a long nav
          list just grows this div past the nav's own h-full bound instead of
          scrolling inside it, and the OUTER <nav> (which used to also carry
          overflow-y-auto) would scroll the whole sidebar -- logo and role
          badge included -- as one blob instead of keeping them pinned while
          only this middle section scrolls. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!isBillingOnly && (
          <>
            <GroupLabel>Navigation</GroupLabel>
            <ul className="space-y-0.5">
              {items.map((item) => (
                <li key={item.href}>
                  <NavLink href={item.href} label={item.label} icon={item.icon} active={isActive(pathname, item.href)} badge={badges?.[item.href] ?? undefined} />
                </li>
              ))}
            </ul>
          </>
        )}

        {showBilling && (
          <>
            <GroupLabel>Billing</GroupLabel>
            {!isBillingOnly && (
              <button
                type="button"
                onClick={() => setBillingOpen((v) => !v)}
                aria-expanded={billingOpen}
                className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  billingActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <Wallet className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="flex-1 text-left">Billing</span>
                {billingOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
              </button>
            )}
            {(billingOpen || isBillingOnly) && (
              <ul className={`mt-0.5 space-y-0.5 ${!isBillingOnly ? 'ps-3' : ''}`}>
                {billingItems.map((item) => (
                  <li key={item.href}>
                    {/* '/billing' is the parent of every other billing entry: exact match only. */}
                    <NavLink href={item.href} label={item.label} icon={item.icon} active={item.href === '/billing' ? pathname === '/billing' : isActive(pathname, item.href)} badge={badges?.[item.href] ?? undefined} demo={item.demo} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {/* Wave B P0-01: billing-only roles still get the Operations entries
            whose roles include them (Tariffs); trailingItems is role-filtered. */}
        {trailingItems.length > 0 && (
          <>
            <GroupLabel>Operations</GroupLabel>
            <ul className="space-y-0.5">
              {trailingItems.map((item) => (
                <li key={item.href}>
                  <NavLink href={item.href} label={item.label} icon={item.icon} active={isActive(pathname, item.href)} badge={badges?.[item.href] ?? undefined} demo={item.demo} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* Role badge at bottom */}
      <div className="shrink-0 border-t border-border px-4 py-3">
        <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/60">{role}</p>
      </div>
    </nav>
  )
}
