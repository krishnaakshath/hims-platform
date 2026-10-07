import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { createHash, timingSafeEqual } from 'crypto'
import { enterResult } from '@/lib/queries/lab-orders'
import { logIntegrationEvent } from '@/lib/patient-portal-audit'
// In a real HIPAA-compliant integration, you would verify an API key,
// mutual TLS (mTLS), or OAuth 2.0 Client Credentials token from your LIS
// (Lab Information System) like Quest Diagnostics, LabCorp, or an interface engine (Redox).

const fhirObservationSchema = z.object({
  resourceType: z.literal('Observation'),
  status: z.string(),
  code: z.object({
    coding: z.array(z.object({
      system: z.string().optional(),
      code: z.string(),
      display: z.string().optional(),
    }))
  }),
  subject: z.object({
    reference: z.string() // e.g. "Patient/RD-0001"
  }),
  valueQuantity: z.object({
    value: z.number(),
    unit: z.string(),
  }).optional(),
  valueString: z.string().optional(),
  referenceRange: z.array(z.object({
    text: z.string()
  })).optional(),
  interpretation: z.array(z.object({
    coding: z.array(z.object({
      code: z.string() // e.g. "H" (High), "L" (Low), "N" (Normal)
    }))
  })).optional(),
  // For matching back to our internal order
  basedOn: z.array(z.object({
    reference: z.string() // e.g. "ServiceRequest/123"
  })).optional()
}).strict()

export async function POST(request: NextRequest) {
  // 1. Verify the LIS integration token. Fail closed: with no token
  // configured the endpoint accepts nothing. Rejected calls are only
  // console.warn'd (never the token or payload) -- an unauthenticated caller
  // must not be able to trigger database writes.
  const expected = process.env.LIS_INTEGRATION_TOKEN?.trim()
  if (!expected) {
    console.warn('LIS webhook called but LIS_INTEGRATION_TOKEN is not configured')
    return NextResponse.json({ error: 'LIS integration is not configured' }, { status: 503 })
  }
  const authHeader = request.headers.get('authorization') ?? ''
  const supplied = /^Bearer +(\S+)$/i.exec(authHeader.trim())?.[1] ?? ''
  // Compare fixed-length digests so neither content nor length leaks via timing.
  const a = createHash('sha256').update(expected).digest()
  const b = createHash('sha256').update(supplied).digest()
  if (!supplied || !timingSafeEqual(a, b)) {
    console.warn('LIS webhook rejected: invalid token')
    return NextResponse.json({ error: 'Unauthorized: Invalid LIS integration token' }, { status: 401 })
  }

  try {
    const json = await readJsonBody(request)
    if (!json.ok) return json.response
    const payload: unknown = json.body
    const parsed = fhirObservationSchema.safeParse(payload)
    
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid FHIR Observation payload', details: parsed.error.flatten() }, { status: 400 })
    }

    const obs = parsed.data
    
    // Strict order id: ServiceRequest/<positive int32>
    const orderMatch = /^ServiceRequest\/([1-9]\d{0,9})$/.exec(obs.basedOn?.[0]?.reference ?? '')
    const orderId = orderMatch ? Number(orderMatch[1]) : NaN
    if (!orderMatch || orderId > 2147483647) {
      return NextResponse.json({ error: 'Missing or invalid basedOn reference. Must be ServiceRequest/{id}' }, { status: 400 })
    }
    // The observation's subject must name the patient who owns the order.
    const patientMatch = /^Patient\/(.+)$/.exec(obs.subject.reference)
    if (!patientMatch) {
      return NextResponse.json({ error: 'Invalid subject reference. Must be Patient/{id}' }, { status: 400 })
    }
    const expectedPatientId = patientMatch[1]

    // Parse FHIR interpretation to our internal flags
    const fhirFlag = obs.interpretation?.[0]?.coding?.[0]?.code
    let flag: 'normal' | 'abnormal' | 'critical' = 'normal'
    if (fhirFlag === 'H' || fhirFlag === 'L') flag = 'abnormal'
    if (fhirFlag === 'LL' || fhirFlag === 'HH' || fhirFlag === 'A' || fhirFlag === 'CR') flag = 'critical'

    // Extract value
    const value = obs.valueQuantity ? obs.valueQuantity.value.toString() : (obs.valueString || '')
    const unit = obs.valueQuantity?.unit
    const referenceRange = obs.referenceRange?.[0]?.text

    // 2. Automatically enter the result in our database
    const result = await enterResult(orderId, {
      value,
      unit,
      referenceRange,
      flag,
      notes: 'Received electronically via FHIR LIS interface',
      resultedByName: 'System (LIS API)',
    }, {
      expectedPatientId,
      // Same transaction as the status UPDATE + result INSERT: any failure rolls all three back.
      afterEntered: (tx, patientId) => logIntegrationEvent(`accepted LIS lab result for order ${orderId}`, patientId, undefined, tx),
    })

    if (!result.ok) {
      return NextResponse.json({ error: 'Order not found, not awaiting a result, or does not belong to this patient' }, { status: 409 })
    }

    return NextResponse.json({ ok: true, message: 'Electronic lab result processed successfully' })
  } catch (error) {
    console.error('LIS webhook failed:', error instanceof Error ? error.message : 'unknown error')
    return NextResponse.json({ error: 'Internal server error processing lab result' }, { status: 500 })
  }
}
