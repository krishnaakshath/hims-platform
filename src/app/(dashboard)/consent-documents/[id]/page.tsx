import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getConsentDocumentWithCounts } from '@/lib/queries/consent-documents'
import { ConsentDocumentEditor } from '@/components/ConsentDocumentEditor'
import { BackLink } from '@/components/BackLink'

export default async function ConsentDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!['admin', 'crc', 'pi'].includes(session.role)) redirect('/')

  const { id } = await params
  const doc = await getConsentDocumentWithCounts(Number(id))
  if (!doc) notFound()
  await logAudit(session, `viewed consent document ${id}`, null)

  return (
    <div>
      <div className="mb-6 space-y-3">
        <BackLink href="/consent-documents" label="Back to Consent Documents" />
        <h1 className="text-2xl font-bold text-foreground">{doc.name}</h1>
      </div>
      <ConsentDocumentEditor document={doc} />
    </div>
  )
}
