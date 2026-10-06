import type { ReactNode } from 'react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { DocumentsTabs } from '@/components/DocumentsTabs'

export default async function DocumentsLayout({ children }: { children: ReactNode }) {
  const session = await requireSessionOrRedirect()
  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold text-foreground">Documents</h1>
      <DocumentsTabs showFaxHistory={['admin', 'crc'].includes(session.role)} />
      <div className="mt-4">{children}</div>
    </div>
  )
}
