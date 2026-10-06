import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { put } from '@vercel/blob'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getDb } from '@/db/client'
import { labOrders } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { invalidateCache, documentsListCacheKey, patientDetailCacheKey } from '@/lib/cache'
import { createDocument } from '@/lib/queries/documents'
import { markCollected } from '@/lib/queries/lab-orders'

// Same allowlist/labels as the generic documents route (POST /api/documents)
// -- see that route's comment on why these four literal mappings are pinned.
const ALLOWED_TYPES: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
}
// Double the generic route's 8MB -- a diagnostic film is not a phone
// snapshot of an insurance card.
const MAX_BYTES = 16 * 1024 * 1024

const attachImagingSchema = z.object({ name: z.string().trim().min(1) }).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // Deliberately the same admin/pi/labs tier as POST /api/lab-orders/[id]/result,
  // NOT the generic documents route's admin/crc/frontdesk tier -- attaching
  // imaging to an order is a clinical act on the lab lifecycle (it can
  // transition ordered -> collected, same as scanning a specimen), not
  // generic document filing (spec §5).
  if (!['admin', 'pi', 'labs'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const orderId = Number((await params).id)
  if (!Number.isInteger(orderId)) return NextResponse.json({ error: 'Invalid order id' }, { status: 400 })

  const formData = await request.formData()
  const file = formData.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'file is required' }, { status: 400 })

  const fileType = ALLOWED_TYPES[file.type]
  if (!fileType) return NextResponse.json({ error: 'File must be a PDF, JPEG, PNG, or WebP' }, { status: 400 })
  if (file.size === 0) return NextResponse.json({ error: 'File is empty' }, { status: 400 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'File must be under 16MB' }, { status: 400 })

  // Build the parse target explicitly from the FormData's non-file entries,
  // dropping empty-string values, exactly like POST /api/documents --
  // because this only copies whatever keys the client actually sent (not a
  // fixed allowlist), .strict() still rejects a client that tries to send
  // patientId/labOrderId/filedByName.
  const fields: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    if (key === 'file') continue
    if (typeof value === 'string' && value !== '') fields[key] = value
  }
  if (fields.name === undefined) fields.name = file.name

  const parsed = attachImagingSchema.safeParse(fields)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid imaging payload', details: parsed.error.flatten() }, { status: 400 })
  }
  const { name } = parsed.data

  // Narrow select -- the live `patients`-adjacent tables have columns other
  // in-flight branches have already migrated away from schema.ts, so a bare
  // select().from(labOrders) risks a 42703 against the real DB.
  const [order] = await getDb()
    .select({ id: labOrders.id, patientId: labOrders.patientId, status: labOrders.status })
    .from(labOrders)
    .where(eq(labOrders.id, orderId))
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (order.status === 'cancelled') {
    return NextResponse.json({ error: 'Cannot attach an image to a cancelled order' }, { status: 409 })
  }

  // Blob before DB, matching POST /api/documents -- an orphaned blob is
  // invisible and cheap; a row pointing at bytes that were never stored is
  // a broken link in a chart.
  const blob = await put(`imaging/${orderId}-${crypto.randomUUID()}-${file.name}`, file, { access: 'private', contentType: file.type })

  const created = await createDocument({
    name,
    documentDate: new Date().toISOString().slice(0, 10),
    receivedFrom: session.name,
    documentType: 'imaging_result',
    patientId: order.patientId,
    admissionId: null,
    labOrderId: orderId,
    fileUrl: blob.url,
    fileType,
    filedByName: session.name,
    filedAt: new Date(),
  })

  // Only advance ordered -> collected; a racing transition means someone
  // else already collected the order, which does not invalidate the upload
  // that just succeeded, so the return value is deliberately ignored here.
  if (order.status === 'ordered') await markCollected(orderId)

  await invalidateCache(documentsListCacheKey())
  await invalidateCache(patientDetailCacheKey(order.patientId))

  await logAudit(session, `attached imaging to lab order ${orderId}`, order.patientId)

  return NextResponse.json({ id: created.id, fileUrl: created.fileUrl }, { status: 201 })
}
