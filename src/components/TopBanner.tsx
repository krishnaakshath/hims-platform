'use client'
import { sendJson } from '@/lib/client-fetch'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LogOut, UserCircle2 } from 'lucide-react'
import { NotificationPanel } from '@/components/NotificationPanel'
import { GlobalSearch } from '@/components/GlobalSearch'
import { PatientAvatar } from '@/components/PatientAvatar'
import { hasSearchScope, searchScopesFor, type SearchScopes } from '@/lib/role-policy'
import type { Role } from '@/lib/auth'

// Wave B P1-24: name only what this role can actually find.
function searchPlaceholder(s: SearchScopes): string {
  if (s.patients && s.trials) return s.services ? 'Search patients, services, trials, forms…' : 'Search patients (name, UHID, mobile), trials, forms…'
  if (s.patients) return s.services ? 'Search patients by name, UHID or mobile, or a service…' : 'Search patients by name, UHID or mobile…'
  if (s.services) return 'Search services (name or code)…'
  return 'Search…'
}

export function TopBanner({ userName, role }: { userName: string; role: Role }) {
  const router = useRouter()

  // Sign-out always lands on /login: the session cookie is cleared server-side,
  // and if that request failed the next request is still re-checked there.
  async function signOut() {
    await sendJson('/api/logout', 'POST')
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="border-b border-sidebar-border bg-sidebar">
      <div className="flex items-center justify-between px-6 py-3">
        {hasSearchScope(role) ? <GlobalSearch placeholder={searchPlaceholder(searchScopesFor(role))} /> : <div />}
        <div className="flex items-center gap-4">
          <NotificationPanel triggerClassName="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" />
          <div className="flex items-center gap-2">
            <PatientAvatar name={userName} size="sm" />
            <span className="text-sm font-medium text-sidebar-foreground">{userName}</span>
          </div>
          {/* Wave B P1-01: every role's own account page (MFA, capabilities). */}
          <Link
            href="/account"
            title="My account and sign-in security"
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <UserCircle2 className="h-4 w-4" aria-hidden="true" />
            My account
          </Link>
          <button
            onClick={signOut}
            title="Sign out of your account"
            aria-label="Sign out of your account"
            className="flex items-center gap-1.5 rounded-md border border-sidebar-border px-3 py-1.5 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
