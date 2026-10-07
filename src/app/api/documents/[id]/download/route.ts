import { NextRequest, NextResponse } from 'next/server'
import { parseId } from '@/lib/http'
import { get } from '@vercel/blob'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { DOCUMENT_READ_ROLES } from '@/lib/role-policy'
import { getDocument } from '@/lib/queries/documents'

// Read access for DOCUMENT_READ_ROLES (admin, crc, pi, frontdesk). Labs is
// admitted ONLY for documents attached to a lab order (imaging thumbnails in
// the lab worklist load through this route); any other document 403s for
// labs, and pharmacy/billing never pass. The blob store itself is private,
// so this route's job is two-fold: it's the only thing that can actually
// reach the bytes (using our own server-side token), and it's what produces
// the audit event that a staff member pulled this document. Used directly as
// an <img src> for inline thumbnails too (ImagingAttachmentStrip), so this
// streams the bytes rather than redirecting to a blob URL the browser could
// never authenticate to on its own.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  // get() throws (rather than returning null) for a fileUrl that isn't a
  // Vercel Blob URL, e.g. seeded rows -- treat that as a missing file. Only
  // the error class name is logged: the message embeds the stored URL.
  let blob: Awaited<ReturnType<typeof get>>
  try {
    blob = await get(existing.fileUrl, { access: 'private' })
  } catch (e) {
    console.warn(`[documents] blob fetch failed for document ${id} (${e instanceof Error ? e.name : 'UnknownError'})`)
    return NextResponse.json({ error: 'Stored file is missing' }, { status: 404 })
  }
  if (!blob || blob.statusCode !== 200) return NextResponse.json({ error: 'Stored file is missing' }, { status: 404 })

  await logAudit(session, `downloaded document ${id}`, existing.patientId)

  return new NextResponse(blob.stream, {
    headers: {
      'Content-Type': blob.blob.contentType,
      'Content-Disposition': `inline; filename="${existing.name.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
    },
  })
}
