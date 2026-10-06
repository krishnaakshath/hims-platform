'use client'
import { useRouter } from 'next/navigation'
import { LogOut } from 'lucide-react'
import { NotificationPanel } from '@/components/NotificationPanel'
import { GlobalSearch } from '@/components/GlobalSearch'
import { PatientAvatar } from '@/components/PatientAvatar'
import { hasSearchScope } from '@/lib/role-policy'
import type { Role } from '@/lib/auth'

export function TopBanner({ userName, role }: { userName: string; role: Role }) {
  const router = useRouter()

  async function signOut() {
    await fetch('/api/logout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="border-b border-sidebar-border bg-sidebar">
      <div className="flex items-center justify-between px-6 py-3">
        {hasSearchScope(role) ? <GlobalSearch /> : <div />}
        <div className="flex items-center gap-4">
          <NotificationPanel role={role} triggerClassName="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" />
          <div className="flex items-center gap-2">
            <PatientAvatar name={userName} size="sm" />
            <span className="text-sm font-medium text-sidebar-foreground">{userName}</span>
          </div>
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
