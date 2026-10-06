import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { PAYER_LOOKUP_ROLES } from '@/lib/role-policy'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'

// Payer prefill for the billing eligibility modal. Returns ONLY the patient's
// primary payer id -- the full detail JSON at ../route.ts is clinical
// (admin/crc/pi). Not audit-logged, matching the sibling insurance-card/[side]
// GET (the other non-clinical insurance read under this path); the clinical
// reads (detail, FHIR/C-CDA) are the ones that audit.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PAYER_LOOKUP_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  const [row] = await getDb()
    .select({ primaryPayerId: patients.primaryPayerId })
    .from(patients)
    .where(eq(patients.id, anonId))
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({ primaryPayerId: row.primaryPayerId ?? null }, { headers: { 'Cache-Control': 'no-store' } })
}
