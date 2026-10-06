import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listConsentDocumentsWithCounts } from '@/lib/queries/consent-documents'
import { NewConsentDocumentButton } from '@/components/NewConsentDocumentButton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

export default async function ConsentDocumentsPage() {
  const session = await requireSessionOrRedirect()
  if (!['admin', 'crc', 'pi'].includes(session.role)) redirect('/')

  const docs = await listConsentDocumentsWithCounts()
  await logAudit(session, 'viewed consent documents', null)

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Consent Documents</h1>
        <NewConsentDocumentButton />
      </div>
      {docs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No consent documents yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Wording</TableHead>
              <TableHead>On Forms</TableHead>
              <TableHead>Signed</TableHead>
              <TableHead>Edit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {docs.map((doc) => {
              const preview = doc.bodyText.length > 80 ? `${doc.bodyText.slice(0, 80)}…` : doc.bodyText
              return (
                <TableRow key={doc.id}>
                  <TableCell className="font-medium">{doc.name}</TableCell>
                  <TableCell className="max-w-md text-muted-foreground">{doc.legalReviewStatus === 'draft' && (
                      <span className="mr-2 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground">Draft</span>
                    )}
                    {preview}
                  </TableCell>
                  <TableCell>{doc.onFormsCount}</TableCell>
                  <TableCell>{doc.signedCount}</TableCell>
                  <TableCell><Link href={`/consent-documents/${doc.id}`} className="text-primary underline">Edit</Link></TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
