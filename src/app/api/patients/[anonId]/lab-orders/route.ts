import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { createLabOrder } from '@/lib/queries/lab-orders'
import { listActiveProviders } from '@/lib/queries/providers'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'

const createLabOrderSchema = z.object({
  labTestId: z.number().int().positive(),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = createLabOrderSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid lab order payload', details: parsed.error.flatten() }, { status: 400 })

  // Resolves who ordered this test with the shared acting-provider resolver
  // (resolveDoctorQueueProvider: the users -> staff -> provider FK link
  // first, then an exact-surname match that returns null on ambiguity).
  //
  // A 'pi' session with no resolvable provider fails CLOSED (403) rather
  // than being silently attributed to another clinician (discharge route
  // precedent). Falling back to the first active provider is scoped to
  // 'admin' only, since admin isn't itself a clinical provider but is one of
  // this route's two allowed roles and needs order creation to stay
  // functional -- a demo-appropriate simplification, not identity resolution.
  const activeProviders = await listActiveProviders()
  if (activeProviders.length === 0) {
    return NextResponse.json({ error: 'No active providers available to attribute this order to' }, { status: 409 })
  }
  const providerMatch = await resolveDoctorQueueProvider(session)

  let orderedByProviderId: number
  if (providerMatch) {
    orderedByProviderId = providerMatch.id
  } else if (session.role === 'admin') {
    orderedByProviderId = activeProviders[0].id
  } else {
    return NextResponse.json({ error: 'Could not resolve your provider identity for this session' }, { status: 403 })
  }

  const created = await createLabOrder({ patientId: anonId, labTestId: parsed.data.labTestId, orderedByProviderId })

  await logAudit(session, 'created lab order', anonId)
  return NextResponse.json(created, { status: 201 })
}
