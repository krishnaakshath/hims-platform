import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { identityVerifications, patients } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { IDENTITY_VERIFY_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import { encryptSensitive } from '@/lib/crypto'
import { KYC_DOC_TYPES } from '@/lib/india/reference'
import { noAadhaar, NO_AADHAAR_MESSAGE } from '@/lib/validation/patient-registration'
import { pgErrorCode } from '@/lib/db-errors'

const verifySchema = z.object({
  // Indian KYC documents (Aadhaar is never a KYC type). Existing 'state_id'
  // rows stay readable: the DB enum value still exists.
  idType: z.enum(KYC_DOC_TYPES),
  idNumber: z.string().trim().min(1).max(40).refine(noAadhaar, NO_AADHAAR_MESSAGE),
}).strict()

export async function PUT(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!IDENTITY_VERIFY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { anonId } = await params

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = verifySchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid identity verification payload', details: parsed.error.flatten() }, { status: 400 })

  try {
    // Wave B P1-09: never record a verification against a patient that does not exist.
    const [patient] = await getDb().select({ id: patients.id }).from(patients).where(eq(patients.id, anonId))
    if (!patient) return NextResponse.json({ error: 'Patient not found' }, { status: 404 })

    const [existing] = await getDb().select({ id: identityVerifications.id }).from(identityVerifications).where(eq(identityVerifications.patientId, anonId))
    const idNumberEncrypted = encryptSensitive(parsed.data.idNumber)

    if (existing) {
      await getDb().update(identityVerifications).set({ idType: parsed.data.idType, idNumberEncrypted, verified: true, verifiedBy: session.name, verifiedAt: new Date() }).where(eq(identityVerifications.patientId, anonId))
    } else {
      await getDb().insert(identityVerifications).values({ patientId: anonId, idType: parsed.data.idType, idNumberEncrypted, verified: true, verifiedBy: session.name, verifiedAt: new Date() })
    }
  } catch (err) {
    console.error('Failed to record identity verification', pgErrorCode(err) ?? err)
    return NextResponse.json({ error: 'Could not save the identity verification. Please try again.' }, { status: 500 })
  }

  await invalidateCache(patientDetailCacheKey(anonId))
  await logAudit(session, `verified identity (${parsed.data.idType})`, anonId)
  return NextResponse.json({ ok: true })
}
