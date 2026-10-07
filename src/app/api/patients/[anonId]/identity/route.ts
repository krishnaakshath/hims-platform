import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { identityVerifications } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { IDENTITY_VERIFY_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import { encryptSensitive } from '@/lib/crypto'
import { KYC_DOC_TYPES } from '@/lib/india/reference'

const verifySchema = z.object({
  // Indian KYC documents (Aadhaar is never a KYC type). Existing 'state_id'
  // rows stay readable: the DB enum value still exists.
  idType: z.enum(KYC_DOC_TYPES),
  idNumber: z.string().min(1),
}).strict()

export async function PUT(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!IDENTITY_VERIFY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { anonId } = await params

  const parsed = verifySchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid identity verification payload', details: parsed.error.flatten() }, { status: 400 })

  const [existing] = await getDb().select().from(identityVerifications).where(eq(identityVerifications.patientId, anonId))
  const idNumberEncrypted = encryptSensitive(parsed.data.idNumber)

  if (existing) {
    await getDb().update(identityVerifications).set({ idType: parsed.data.idType, idNumberEncrypted, verified: true, verifiedBy: session.name, verifiedAt: new Date() }).where(eq(identityVerifications.patientId, anonId))
  } else {
    await getDb().insert(identityVerifications).values({ patientId: anonId, idType: parsed.data.idType, idNumberEncrypted, verified: true, verifiedBy: session.name, verifiedAt: new Date() })
  }

  await invalidateCache(patientDetailCacheKey(anonId))
  await logAudit(session, 'verified identity', anonId)
  return NextResponse.json({ ok: true })
}
