import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { put } from '@vercel/blob'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getDb } from '@/db/client'
import { patients, documentTypeEnum } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { invalidateCache, documentsListCacheKey, patientDetailCacheKey } from '@/lib/cache'
import { createDocument, isAdmissionForPatient } from '@/lib/queries/documents'

// Scope Decision 2's pin: exactly these four MIME types map to exactly these
// four fileType labels. A future allowlist "harmonization" (e.g. adding
// image/gif, or renaming "JPG" to "JPEG") must break the route test that
// asserts on these literal values -- that's deliberate, not an oversight.
const ALLOWED_TYPES: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
}
const MAX_BYTES = 8 * 1024 * 1024

const receiveDocumentSchema = z
  .object({
    name: z.string().trim().min(1),
    documentDate: z.string().min(1),
    receivedFrom: z.string().trim().min(1),
    documentType: z.enum(documentTypeEnum.enumValues),
    patientId: z.string().trim().min(1).optional(),
    admissionId: z.coerce.number().int().positive().optional(),
  })
  .strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'frontdesk'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const formData = await request.formData()
  const file = formData.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'file is required' }, { status: 400 })

  const fileType = ALLOWED_TYPES[file.type]
  if (!fileType) return NextResponse.json({ error: 'File must be a PDF, JPEG, PNG, or WebP' }, { status: 400 })
  // A zero-byte upload is a failed scan, not a document -- reject it
  // alongside the MAX_BYTES check rather than letting it through as a
  // "successfully filed" empty file.
  if (file.size === 0) return NextResponse.json({ error: 'File is empty' }, { status: 400 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'File must be under 8MB' }, { status: 400 })

  // Build the parse target explicitly from the FormData's non-file entries,
  // dropping empty-string values -- an unselected "Patient (leave blank if
  // unknown)" <select> posts '', and .strict() + .min(1) would otherwise
  // turn "left blank on purpose" into a 400. Because this only copies
  // whatever keys the client actually sent (not a fixed allowlist), .strict()
  // still rejects a client that tries to mass-assign a field like
  // filedByName or status.
  const fields: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    if (key === 'file') continue
    if (typeof value === 'string' && value !== '') fields[key] = value
  }
  // name defaults to the uploaded file's name when the form omits it --
  // applied before safeParse so .min(1) still guards the genuinely empty case.
  if (fields.name === undefined) fields.name = file.name

  const parsed = receiveDocumentSchema.safeParse(fields)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid document payload', details: parsed.error.flatten() }, { status: 400 })
  }
  const { name, documentDate, receivedFrom, documentType, patientId, admissionId } = parsed.data

  if (admissionId !== undefined && patientId === undefined) {
    return NextResponse.json({ error: 'admissionId requires a patientId' }, { status: 400 })
  }

  if (patientId !== undefined) {
    // Narrow select -- the live `patients` table has columns other in-flight
    // branches have already migrated away from schema.ts, so a bare
    // select().from(patients) can 42703 on an unrelated column.
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).where(eq(patients.id, patientId))
    if (!patientRow) return NextResponse.json({ error: 'patientId does not exist' }, { status: 400 })
  }

  if (admissionId !== undefined && patientId !== undefined) {
    const belongs = await isAdmissionForPatient(admissionId, patientId)
    if (!belongs) return NextResponse.json({ error: 'admissionId does not belong to this patient' }, { status: 400 })
  }

  // UUID prefix, not a timestamp -- two coordinators scanning the same
  // standard form name in the same second must not collide.
  const blob = await put(`documents/${crypto.randomUUID()}-${file.name}`, file, { access: 'private', contentType: file.type })

  const created = await createDocument({
    name,
    documentDate,
    receivedFrom,
    documentType,
    patientId: patientId ?? null,
    admissionId: admissionId ?? null,
    // Never set by this generic route -- only the order-scoped upload route
    // (Task 3) associates a document with a lab order, and it derives
    // patientId from the order itself so the two can never disagree.
    labOrderId: null,
    fileUrl: blob.url,
    fileType,
    filedByName: patientId !== undefined ? session.name : null,
    filedAt: patientId !== undefined ? new Date() : null,
  })

  await invalidateCache(documentsListCacheKey())
  if (patientId !== undefined) await invalidateCache(patientDetailCacheKey(patientId))

  await logAudit(session, `received document "${name}" (${documentType})`, patientId ?? null)

  return NextResponse.json({ id: created.id, fileUrl: created.fileUrl }, { status: 201 })
}
