import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withServiceGuard } from '@/lib/service-config'
import { putPrivateBlob, safeBlobSegment } from '@/lib/blob-store'
import { getActiveIntakeSubmission } from '@/lib/queries/intake-portal'
import { createDocument } from '@/lib/queries/documents'
import { checkIntakeFileUploadRateLimit } from '@/lib/rate-limit'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { invalidateCache, documentsListCacheKey, patientDetailCacheKey } from '@/lib/cache'
import { todayIsoIn } from '@/lib/india-time'

// WS7 T3: the upload behind an intake form's file question. Deliberately NOT
// requireSession()- or requirePatientSession()-gated -- a referred patient has
// no account. Authorization is possession of the unguessable intake token,
// checked first by getActiveIntakeSubmission (unknown, expired or completed ->
// the same 404 the other intake routes answer, before anything is read or
// stored). The file goes only through the blob driver; the response is the
// answer reference `doc:<id>` and the file name -- never a blob URL or path.

const MAX_BYTES = 5 * 1024 * 1024
// Generous multipart overhead: a body larger than this cannot hold a file under
// MAX_BYTES, so it is refused before being read into memory.
const MAX_BODY_BYTES = MAX_BYTES + 64 * 1024
const TOO_LARGE = 'Files must be 5 MB or smaller.'
const NOT_ALLOWED = 'Upload a PDF, JPEG or PNG file.'

// The bytes decide the type, never the name or the declared MIME type: an
// .exe renamed .pdf is still an .exe.
const SIGNATURES: { contentType: string; fileType: string; magic: number[] }[] = [
  { contentType: 'application/pdf', fileType: 'PDF', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { contentType: 'image/jpeg', fileType: 'JPG', magic: [0xff, 0xd8, 0xff] },
  { contentType: 'image/png', fileType: 'PNG', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
]

function sniff(bytes: Uint8Array) {
  return SIGNATURES.find((s) => s.magic.every((b, i) => bytes[i] === b)) ?? null
}

const fieldsSchema = z.object({ questionId: z.string().min(1).max(100) }).strict()

const gone = () => NextResponse.json({ error: 'This link is no longer valid.' }, { status: 404 })

export const POST = withServiceGuard('intake file upload', async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const submission = await getActiveIntakeSubmission(token)
  if (!submission) return gone()

  if (!(await checkIntakeFileUploadRateLimit(submission.id)).allowed) {
    return NextResponse.json({ error: 'Too many uploads. Please wait a few minutes and try again.' }, { status: 429 })
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0')
  if (declaredLength > MAX_BODY_BYTES) return NextResponse.json({ error: TOO_LARGE }, { status: 413 })

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid upload' }, { status: 400 })
  }
  const file = formData.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a file to upload.' }, { status: 400 })
  const fields: Record<string, unknown> = {}
  for (const [key, value] of formData.entries()) if (key !== 'file') fields[key] = value
  const parsed = fieldsSchema.safeParse(fields)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid upload' }, { status: 400 })

  const question = submission.questions.find((q) => q.id === parsed.data.questionId)
  if (!question || question.type !== 'file') return NextResponse.json({ error: 'Invalid upload' }, { status: 400 })

  if (file.size > MAX_BYTES) return NextResponse.json({ error: TOO_LARGE }, { status: 413 })
  if (file.size === 0) return NextResponse.json({ error: 'The file is empty.' }, { status: 400 })
  const bytes = new Uint8Array(await file.arrayBuffer())
  const kind = sniff(bytes)
  if (!kind) return NextResponse.json({ error: NOT_ALLOWED }, { status: 400 })

  const fileName = file.name.trim().slice(0, 200) || 'Uploaded file'
  const blob = await putPrivateBlob(`intake/${crypto.randomUUID()}-${safeBlobSegment(fileName)}`, bytes, kind.contentType)
  const doc = await createDocument({
    name: fileName,
    documentDate: todayIsoIn(),
    receivedFrom: 'Patient form', // status defaults to 'new': staff file it like any received document
    documentType: 'other',
    patientId: submission.patientId,
    admissionId: null,
    labOrderId: null,
    fileUrl: blob.url,
    fileType: kind.fileType,
    filedByName: null,
    filedAt: null,
  })

  await invalidateCache(documentsListCacheKey())
  await invalidateCache(patientDetailCacheKey(submission.patientId))
  await logPatientPortalAction('uploaded form file', submission.patientId, `submission=${submission.id}`)

  return NextResponse.json({ answer: `doc:${doc.id}`, fileName }, { status: 201 })
})
