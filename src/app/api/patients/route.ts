import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import { requireSession } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { invalidateCache, patientListCacheKey } from '@/lib/cache'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { getPayerById } from '@/lib/queries/payers'

// Collects the same demographic shape a chart would carry (no
// referralType/availability/consent -- those belong to an intake, which this
// patient doesn't have yet) and writes it straight into the app's own
// `patients` row.
const addClientSchema = z.object({
  name: z.string().min(1),
  dob: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  city: z.string().optional(),
  zip: z.string().optional(),
  currentProvider: z.string().optional(),
  primaryPayerId: z.number().int().optional(),
  primaryMemberId: z.string().optional(),
  primaryGroupNumber: z.string().optional(),
  primaryPlanType: z.enum(['ppo', 'hmo', 'epo', 'pos', 'medicare', 'medicaid']).optional(),
  primarySubscriberName: z.string().optional(),
  primarySubscriberRelationship: z.enum(['self', 'spouse', 'child', 'other']).optional(),
}).strict()

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // RBAC ruling 1: patient JSON is clinical -- frontdesk's patient views are
  // rendered server-side from the query functions, not this API.
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const trialId = request.nextUrl.searchParams.get('trialId')
  const patientsWithStatus = await listPatientsWithStatus(trialId)

  await logAudit(session, 'viewed patient list', null)

  return NextResponse.json({ patients: patientsWithStatus })
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // Patient registration (inpatient and outpatient) is front desk's job
  // exclusively, admin kept as the practice-wide override -- crc previously
  // had this too, removed per explicit product direction.
  if (!['admin', 'frontdesk'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = addClientSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid new-client payload', details: parsed.error.flatten() }, { status: 400 })

  if (parsed.data.primaryPayerId !== undefined) {
    const payer = await getPayerById(parsed.data.primaryPayerId)
    if (!payer) return NextResponse.json({ error: 'primaryPayerId does not reference a real payer' }, { status: 400 })
  }

  // Anon IDs are RD-#### sequential; find the current max and increment.
  // Only consider ids that actually match the RD-#### shape -- Math.max
  // propagates NaN from a single bad operand to its entire result, so any
  // non-conforming id (e.g. a dedicated TEST-*-<timestamp> fixture id left
  // behind by a test that didn't clean itself up) would otherwise
  // permanently poison every future call to "RD-0NaN", which then collides
  // on the unique constraint forever after the first one.
  const existing = await getDb().select({ id: patients.id }).from(patients)
  const existingNumbers = existing
    .map((p) => /^RD-(\d+)$/.exec(p.id))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => parseInt(m[1], 10))
  const nextNum = existingNumbers.length === 0 ? 1 : Math.max(...existingNumbers) + 1
  const newId = `RD-${String(nextNum).padStart(4, '0')}`

  const [created] = await getDb().insert(patients).values({
    id: newId,
    name: parsed.data.name.trim(),
    dob: parsed.data.dob,
    city: parsed.data.city ?? null,
    zip: parsed.data.zip ?? null,
    phone: parsed.data.phone ?? null,
    email: parsed.data.email ?? null,
    currentProvider: parsed.data.currentProvider ?? null,
    primaryPayerId: parsed.data.primaryPayerId ?? null,
    primaryMemberId: parsed.data.primaryMemberId ?? null,
    primaryGroupNumber: parsed.data.primaryGroupNumber ?? null,
    primaryPlanType: parsed.data.primaryPlanType ?? null,
    primarySubscriberName: parsed.data.primarySubscriberName ?? null,
    primarySubscriberRelationship: parsed.data.primarySubscriberRelationship ?? null,
  }).returning()

  await invalidateCache(patientListCacheKey(null))
  await logAudit(session, 'added new client', newId)
  return NextResponse.json(created, { status: 201 })
}
