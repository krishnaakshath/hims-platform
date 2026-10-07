import type { ReactNode } from 'react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { DocumentsTabs } from '@/components/DocumentsTabs'
import { demoFeaturesEnabled } from '@/lib/demo-features'

export default async function DocumentsLayout({ children }: { children: ReactNode }) {
  const session = await requireSessionOrRedirect()
  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold text-foreground">Documents</h1>
      {/* Wave B P1-21: Fax History is simulated -- shown only with DEMO_FEATURES on. */}
      <DocumentsTabs showFaxHistory={['admin', 'crc'].includes(session.role) && demoFeaturesEnabled()} />
      <div className="mt-4">{children}</div>
    </div>
  )
}
