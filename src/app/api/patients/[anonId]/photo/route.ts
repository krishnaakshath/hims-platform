import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import { withServiceGuard } from '@/lib/service-config'
import { deletePrivateBlob, putPrivateBlob, safeBlobSegment, streamPrivateBlob } from '@/lib/blob-store'
import { PATIENT_DIRECTORY_ROLES, PATIENT_PROFILE_EDIT_ROLES, REGISTRATION_ROLES } from '@/lib/role-policy'

// WS6 T8: the patient's photo (the existing patients.photo_blob_path). POST stores a JPEG,
// PNG or WebP of at most 2 MB in the private file store -- the type is read from the file's
// own bytes, never trusted from the upload -- and GET streams it back through this audited
// route. Neither ever returns the stored URL or path.

const MAX_BYTES = 2 * 1024 * 1024
const UPLOAD_ROLES = [...new Set([...REGISTRATION_ROLES, ...PATIENT_PROFILE_EDIT_ROLES])]
// Only the file part is accepted: any other form field is a 400.
const fieldsSchema = z.object({}).strict()

/** The image type from the leading bytes, or null when the bytes are not a JPEG, PNG or WebP. */
function sniffImageType(b: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'image/png'
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to))
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

const bad = (error: string) => NextResponse.json({ error }, { status: 400 })

export const POST = withServiceGuard('patient photo upload', async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!UPLOAD_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return bad('Send the photo as a multipart form with a file field')
  }
  const file = form.get('file')
  if (!(file instanceof File)) return bad('file is required')
  const fields: Record<string, string> = {}
  for (const [key, value] of form.entries()) if (key !== 'file') fields[key] = typeof value === 'string' ? value : ''
  if (!fieldsSchema.safeParse(fields).success) return bad('Only a file field is accepted')
  if (file.size === 0) return bad('The photo is empty')
  if (file.size > MAX_BYTES) return bad('The photo must be 2 MB or smaller')

  const bytes = new Uint8Array(await file.arrayBuffer())
  const contentType = sniffImageType(bytes)
  if (!contentType) return bad('The photo must be a JPEG, PNG or WebP image')

  const [row] = await getDb().select({ id: patients.id, photo: patients.photoBlobPath }).from(patients).where(eq(patients.id, anonId))
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Blob before row: an orphaned file is invisible; a row pointing at missing bytes is not.
  const blob = await putPrivateBlob(`patient-photos/${safeBlobSegment(anonId)}-${crypto.randomUUID()}`, bytes, contentType)
  await getDb().update(patients).set({ photoBlobPath: blob.url }).where(eq(patients.id, anonId))
  if (row.photo) await deletePrivateBlob(row.photo) // the replaced photo; best-effort
  await invalidateCache(patientDetailCacheKey(anonId))
  await logAudit(session, row.photo ? 'replaced patient photo' : 'uploaded patient photo', anonId, `type=${contentType} bytes=${bytes.length}`)
  return NextResponse.json({ ok: true }, { status: 201 })
})

export const GET = withServiceGuard('patient photo view', async function GET(_request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PATIENT_DIRECTORY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  const [row] = await getDb().select({ photo: patients.photoBlobPath }).from(patients).where(eq(patients.id, anonId))
  if (!row?.photo) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const res = await streamPrivateBlob(row.photo, { filename: `${safeBlobSegment(anonId)}-photo`, disposition: 'inline' })
  if (!res) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await logAudit(session, 'viewed patient photo', anonId)
  return res
})
