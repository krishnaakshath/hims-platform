import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import { createPrescription } from '@/lib/queries/prescriptions'
import { listActiveProviders } from '@/lib/queries/providers'
import { resolveSessionProvider } from '@/lib/provider-identity'

const createPrescriptionSchema = z.object({
  medicationId: z.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(200),
  medicationClass: z.string().trim().min(1).max(100),
  dose: z.string().trim().min(1).max(100).nullable().optional(),
  // `frequencyPerDay <= 6` and `durationDays <= 365` are structural sanity
  // bounds on an integer field, NOT dosing-safety validation (spec §1,
  // out of scope) -- they exist so a typo'd "300 times daily" is rejected
  // as malformed input, without the app claiming it validated a regimen.
  frequencyPerDay: z.number().int().min(1).max(6),
  durationDays: z.number().int().min(1).max(365),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  instructions: z.string().trim().max(500).nullable().optional(),
  onBehalfOfProviderId: z.number().int().positive().optional(),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // Ordering and prescribing are the clinical tier (spec §10); `crc` and
  // `frontdesk` are coordination and registration roles and never reach it.
  if (!['admin', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  const parsed = createPrescriptionSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid prescription payload', details: parsed.error.flatten() }, { status: 400 })

  // Prescriber resolution ladder (Review Focus #4).
  const resolved = await resolveSessionProvider(session)
  let prescribedByProviderId: number
  if (resolved) {
    // The resolved identity always wins. onBehalfOfProviderId is IGNORED
    // here rather than rejected -- a doctor must not be able to prescribe
    // under someone else's name just by adding a field to the body.
    prescribedByProviderId = resolved.id
  } else if (session.role === 'admin') {
    // Deliberately NOT "fall back to the first active provider" the way
    // lab-orders does: silently attributing a prescription to whoever sorts
    // first is a fabricated clinical fact on the one field where that is
    // least acceptable. An explicit picker records what actually happened.
    const onBehalfOf = parsed.data.onBehalfOfProviderId
    if (onBehalfOf === undefined) return NextResponse.json({ error: 'Select the provider you are prescribing on behalf of.' }, { status: 400 })
    const match = (await listActiveProviders()).find((p) => p.id === onBehalfOf)
    if (!match) return NextResponse.json({ error: 'That provider is not on the active roster.' }, { status: 400 })
    prescribedByProviderId = match.id
  } else {
    // Fail closed for `pi`: unlike doctor/page.tsx's deliberate fuzzy-name
    // fallback, this is the write path for a controlled clinical fact and
    // must not guess. The message is actionable -- linking a `users` row to
    // a `providers` row in the Staff Directory is an existing admin
    // capability, not something to build -- and covers both a genuinely
    // unlinked account and a pre-deploy session JWT with no `userId` claim
    // (Task 1: those sessions resolve `userId: null` for up to 8h after
    // deploy, until the user signs out and back in).
    return NextResponse.json({ error: 'Could not resolve your provider identity. Ask an admin to link your account to a provider in the Staff Directory.' }, { status: 403 })
  }

  const created = await createPrescription({
    patientId: anonId,
    medicationId: parsed.data.medicationId ?? null,
    name: parsed.data.name,
    medicationClass: parsed.data.medicationClass,
    dose: parsed.data.dose ?? null,
    frequencyPerDay: parsed.data.frequencyPerDay,
    durationDays: parsed.data.durationDays,
    startDate: parsed.data.startDate,
    instructions: parsed.data.instructions ?? null,
    prescribedByProviderId,
    enteredByName: session.name,
  })

  // Required, unlike lab-orders: getPatientDetail caches `medications` for
  // 30 seconds, and a freshly written prescription would otherwise be
  // invisible on the very page that wrote it.
  await invalidateCache(patientDetailCacheKey(anonId))
  await logAudit(session, `prescribed ${parsed.data.name}`, anonId)
  return NextResponse.json(created, { status: 201 })
}
