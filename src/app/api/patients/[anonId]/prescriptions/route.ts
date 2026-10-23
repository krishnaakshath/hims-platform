import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { patientExists } from '@/lib/queries/patient-exists'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import { activeAllergies, createPrescription, drugAllergyConflicts } from '@/lib/queries/prescriptions'
import { listActiveProviders } from '@/lib/queries/providers'
import { resolveSessionProvider } from '@/lib/provider-identity'
import { parseDosePattern, prescribedQuantity } from '@/lib/prescriptions/dose-pattern'
import { getDb } from '@/db/client'
import { medications } from '@/db/schema'
import { eq } from 'drizzle-orm'

const createPrescriptionSchema = z.object({
  medicationId: z.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(200),
  medicationClass: z.string().trim().min(1).max(100),
  // WS1 T6: dose is mandatory on every new prescription (spec ruling 8); legacy rows stay nullable.
  dose: z.string().trim().min(1).max(100),
  // WS1 T6: an Indian dose pattern ('1-0-1'); when sent it overrides frequencyPerDay.
  dosePattern: z.string().trim().max(20).optional(),
  // `frequencyPerDay <= 6` and `durationDays <= 365` are structural sanity
  // bounds on an integer field, NOT dosing-safety validation (spec §1,
  // out of scope) -- they exist so a typo'd "300 times daily" is rejected
  // as malformed input, without the app claiming it validated a regimen.
  frequencyPerDay: z.number().int().min(1).max(6).optional(),
  durationDays: z.number().int().min(1).max(365),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  instructions: z.string().trim().max(500).nullable().optional(),
  onBehalfOfProviderId: z.number().int().positive().optional(),
  // WS1 T6 (spec ruling 9): needed to prescribe against a recorded allergy.
  allergyOverrideReason: z.string().trim().min(5).max(300).optional(),
}).strict().superRefine((b, ctx) => { // WS1 T6
  if (b.dosePattern !== undefined && b.dosePattern !== '') {
    if (!parseDosePattern(b.dosePattern)) ctx.addIssue({ code: 'custom', path: ['dosePattern'], message: 'Use a pattern like 1-0-1' })
  } else if (b.frequencyPerDay === undefined) {
    ctx.addIssue({ code: 'custom', path: ['frequencyPerDay'], message: 'Give a dose pattern or a frequency' })
  }
})

export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // Ordering and prescribing are the clinical tier (spec §10); `crc` and
  // `frontdesk` are coordination and registration roles and never reach it.
  if (!['admin', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = createPrescriptionSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid prescription payload', details: parsed.error.flatten() }, { status: 400 })

  if (!(await patientExists(anonId))) return NextResponse.json({ error: 'Patient not found' }, { status: 404 })

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

  // WS1 T6: the pattern, when given, sets frequencyPerDay; the quantity needs the catalogue form.
  const pattern = parsed.data.dosePattern ? parseDosePattern(parsed.data.dosePattern) : null
  const frequencyPerDay = pattern?.perDay ?? parsed.data.frequencyPerDay!
  const medicationId = parsed.data.medicationId ?? null
  const [catalogRow] = medicationId === null ? [] : await getDb()
    .select({ form: medications.form, name: medications.name, genericName: medications.genericName, medicationClass: medications.medicationClass })
    .from(medications).where(eq(medications.id, medicationId))

  // WS1 T6 (spec ruling 9): the same allergy check as the encounter route; a conflict needs a reason.
  const conflicts = drugAllergyConflicts(parsed.data, catalogRow ?? null, await activeAllergies(anonId))
  if (conflicts.length > 0 && !parsed.data.allergyOverrideReason) {
    return NextResponse.json({ error: 'This prescription conflicts with a recorded allergy.', code: 'allergy_conflict', conflicts }, { status: 422 })
  }

  const created = await createPrescription({
    patientId: anonId,
    medicationId,
    name: parsed.data.name,
    medicationClass: parsed.data.medicationClass,
    dose: parsed.data.dose,
    frequencyPerDay,
    dosePattern: pattern?.label ?? null,
    quantityPrescribed: prescribedQuantity({ pattern, frequencyPerDay, durationDays: parsed.data.durationDays, form: catalogRow?.form ?? 'other', isSos: false }),
    // Stored only when the drug actually conflicted: the reason answers that conflict.
    allergyOverrideReason: conflicts.length > 0 ? parsed.data.allergyOverrideReason ?? null : null,
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
  // Ids and counts only: no drug name in the audit row (WS1 T6, audit constraint).
  await logAudit(session, 'wrote prescription', anonId, `episode=${created.id} overrides=${conflicts.length > 0 ? 1 : 0}`)
  return NextResponse.json(created, { status: 201 })
}
