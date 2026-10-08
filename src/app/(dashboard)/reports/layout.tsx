import type { ReactNode } from 'react'
import { getSession } from '@/lib/auth'
import { ReportsSidebar } from '@/components/ReportsSidebar'

// Wave I: the sidebar lists only the reports the signed-in role can open. Each
// page still gates itself; this layout reads no data.
export default async function ReportsLayout({ children }: { children: ReactNode }) {
  const session = await getSession()
  return (
    <div className="flex gap-6">
      {session && <ReportsSidebar role={session.role} />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
