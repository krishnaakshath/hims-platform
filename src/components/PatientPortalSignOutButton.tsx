'use client'
import { sendJson } from '@/lib/client-fetch'
import { useRouter } from 'next/navigation'
import { LogOut } from 'lucide-react'

export function PatientPortalSignOutButton() {
  const router = useRouter()
  async function signOut() {
    await sendJson('/api/patient-portal/logout', 'POST')
    router.push('/patient-portal/login')
  }
  return (
    <button onClick={signOut} className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary">
      <LogOut className="h-4 w-4" aria-hidden="true" />
      Sign out
    </button>
  )
}
