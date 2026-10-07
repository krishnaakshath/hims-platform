import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { AADHAAR_WRITE_ROLES } from '@/lib/role-policy'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import { buildAadhaarRow } from '@/lib/patient-identity'
import { getIdentitySnapshot, upsertPatientAadhaar } from '@/lib/queries/patient-profile'
import { aadhaarInputSchema } from '@/lib/validation/patient-registration'
import { pgConstraint, pgErrorCode } from '@/lib/db-errors'

// Record or replace a patient's Aadhaar (with consent) or its decline reason.
// This is crc's only Aadhaar write path (registration is admin/frontdesk).
// Both branches are strict: no extra key can ride along. The plaintext goes
// straight into buildAadhaarRow (encrypted there); the response is the status
// alone -- no last4, even for admin/crc, since the page re-reads the record.
const aadhaarUpdateSchema = z.discriminatedUnion('status', [
  aadhaarInputSchema.options[0].strict(),
  aadhaarInputSchema.options[1].strict(),
])

export async function PUT(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!AADHAAR_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { anonId } = await params

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const body: unknown = json.body
  // Validation messages are fixed strings; flatten() never carries the input.
  const parsed = aadhaarUpdateSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid Aadhaar update', details: parsed.error.flatten() }, { status: 400 })

  const current = await getIdentitySnapshot(anonId)
  if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let status: 'on_file' | 'declined'
  try {
    const row = buildAadhaarRow(anonId, parsed.data, session.name, new Date())
    status = row.aadhaarLast4 != null ? 'on_file' : 'declined'
    await upsertPatientAadhaar(anonId, row, session)
  } catch (err) {
    // Code and constraint only: a driver error message carries the params.
    console.error(`[patients] Aadhaar update failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }

  try {
    await invalidateCache(patientDetailCacheKey(anonId))
  } catch (err) {
    console.error(`[patients] detail cache invalidation failed (${err instanceof Error ? err.name : typeof err})`)
  }
  return NextResponse.json({ status })
}
