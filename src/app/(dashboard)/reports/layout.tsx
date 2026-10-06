import type { ReactNode } from 'react'
import { ReportsSidebar } from '@/components/ReportsSidebar'

export default function ReportsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-6">
      <ReportsSidebar />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
