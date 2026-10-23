import { NextRequest, NextResponse } from 'next/server'
import { parseId } from '@/lib/http'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { DOCUMENT_READ_ROLES } from '@/lib/role-policy'
import { getDocument } from '@/lib/queries/documents'
import { withServiceGuard } from '@/lib/service-config'
import { readPrivateBlob } from '@/lib/blob-store'

// Read access for DOCUMENT_READ_ROLES (admin, crc, pi, frontdesk). Labs is
// admitted ONLY for documents attached to a lab order (imaging thumbnails in
// the lab worklist load through this route); any other document 403s for
// labs, and pharmacy/billing never pass. The blob store itself is private,
// so this route's job is two-fold: it's the only thing that can actually
// reach the bytes (from the server's private file store), and it's what produces
// the audit event that a staff member pulled this document. Used directly as
// an <img src> for inline thumbnails too (ImagingAttachmentStrip), so this
// streams the bytes rather than redirecting to a blob URL the browser could
// never authenticate to on its own.
export const GET = withServiceGuard('document download', async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!DOCUMENT_READ_ROLES.includes(session.role) && session.role !== 'labs') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await params
  const numericId = parseId(id)
  if (numericId === null) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const existing = await getDocument(numericId)
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (session.role === 'labs' && existing.labOrderId === null) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (!existing.fileUrl) {
    return NextResponse.json({ error: 'This is a metadata-only record with no stored file' }, { status: 404 })
  }

  // A fileUrl this store cannot read (e.g. seeded rows with a placeholder URL)
  // is a missing file. readPrivateBlob logs only the error class name.
  const blob = await readPrivateBlob(existing.fileUrl)
  if (!blob) return NextResponse.json({ error: 'Stored file is missing' }, { status: 404 })

  await logAudit(session, `downloaded document ${id}`, existing.patientId)

  return new NextResponse(Buffer.from(blob.bytes), {
    headers: {
      'Content-Type': blob.contentType,
      'Content-Disposition': `inline; filename="${existing.name.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
    },
  })
})
