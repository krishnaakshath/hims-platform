// WS7 T9 (spec D15): the signed-in patient adds an insurance policy or their ABHA from the portal.
// It lands in portal_submissions as 'pending' for the front desk; nothing reaches a policy or the
// chart here. Multipart: `kind` plus the policy or ABHA fields, and an optional `card` image
// (PDF, JPEG or PNG up to 5 MB, typed by its bytes). A second pending submission of the same kind
// is a 409. The response is the submission id only -- never a file path or blob URL.
import { NextRequest, NextResponse } from 'next/server'
import { requirePatientSession } from '@/lib/patient-session'
import { withServiceGuard } from '@/lib/service-config'
import { sniffUpload } from '@/lib/upload-sniff'
import { createPortalSubmission, portalAbhaFieldsSchema, portalPolicyFieldsSchema, type PortalSubmissionInput } from '@/lib/queries/portal-submissions'
import { invalidateCache, documentsListCacheKey } from '@/lib/cache'
import { todayIsoIn } from '@/lib/india-time'

const MAX_BYTES = 5 * 1024 * 1024
const MAX_BODY_BYTES = MAX_BYTES + 64 * 1024
const TOO_LARGE = 'Files must be 5 MB or smaller.'
const NOT_ALLOWED = 'Upload a PDF, JPEG or PNG file.'
const INVALID = 'Please check the details and try again.'

export const POST = withServiceGuard('portal self-service', async function POST(request: NextRequest) {
  const session = await requirePatientSession()
  if (session instanceof NextResponse) return session

  const declaredLength = Number(request.headers.get('content-length') ?? '0')
  if (declaredLength > MAX_BODY_BYTES) return NextResponse.json({ error: TOO_LARGE }, { status: 413 })

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: INVALID }, { status: 400 })
  }
  const fields: Record<string, unknown> = {}
  let file: File | null = null
  for (const [key, value] of formData.entries()) {
    if (key === 'card') {
      if (!(value instanceof File) || file) return NextResponse.json({ error: INVALID }, { status: 400 })
      if (value.size > 0) file = value
    } else if (typeof value === 'string') {
      // An empty optional field is the same as leaving it out.
      if (value.trim() !== '') fields[key] = value
    } else {
      return NextResponse.json({ error: INVALID }, { status: 400 })
    }
  }

  let input: PortalSubmissionInput
  if (fields.kind === 'policy') {
    const parsed = portalPolicyFieldsSchema.safeParse(fields)
    // Field-level messages are fixed schema text, never the typed values.
    if (!parsed.success) return NextResponse.json({ error: INVALID, fields: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? 'form'), i.message])) }, { status: 400 })
    const { insurerName, policyNumber, validFrom, validTo, sumInsuredPaise } = parsed.data
    const payload = { insurerName, policyNumber, validFrom, validTo, ...(sumInsuredPaise === undefined ? {} : { sumInsuredPaise }) }
    if (payload.validTo < todayIsoIn()) return NextResponse.json({ error: 'This policy has already ended.', fields: { validTo: 'This policy has already ended.' } }, { status: 400 })
    input = { kind: 'policy', payload }
  } else if (fields.kind === 'abha') {
    const parsed = portalAbhaFieldsSchema.safeParse(fields)
    if (!parsed.success) return NextResponse.json({ error: INVALID, fields: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? 'form'), i.message])) }, { status: 400 })
    const { abhaNumber, abhaAddress } = parsed.data
    input = { kind: 'abha', payload: abhaAddress === undefined ? { abhaNumber } : { abhaNumber, abhaAddress } }
  } else {
    return NextResponse.json({ error: INVALID }, { status: 400 })
  }

  let card: Parameters<typeof createPortalSubmission>[2]
  if (file) {
    if (file.size > MAX_BYTES) return NextResponse.json({ error: TOO_LARGE }, { status: 413 })
    const bytes = new Uint8Array(await file.arrayBuffer())
    const sniffed = sniffUpload(bytes)
    if (!sniffed) return NextResponse.json({ error: NOT_ALLOWED }, { status: 400 })
    card = { bytes, ...sniffed }
  }

  const result = await createPortalSubmission(session.patientId, input, card)
  if (!result.ok) {
    return NextResponse.json({ error: input.kind === 'policy' ? 'You already have a policy waiting for the front desk to check.' : 'Your ABHA is already waiting for the front desk to check.' }, { status: 409 })
  }
  if (card) await invalidateCache(documentsListCacheKey())
  return NextResponse.json({ id: result.id }, { status: 201 })
})
