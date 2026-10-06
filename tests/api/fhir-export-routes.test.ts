import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { eq, desc, inArray } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { getDb } from '@/db/client'
import { patients, allergies, diagnoses, auditLog } from '@/db/schema'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' | 'pharmacy' | 'billing' | 'labs' | null = 'crc'
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () =>
    sessionRole === null
      ? NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      : { role: sessionRole, name: 'Test Staff' }
  ),
}))

import { GET as getPatient } from '@/app/api/patients/[anonId]/fhir/Patient/route'
import { GET as getAllergyIntolerance } from '@/app/api/patients/[anonId]/fhir/AllergyIntolerance/route'
import { GET as getCondition } from '@/app/api/patients/[anonId]/fhir/Condition/route'
import { GET as getMedicationRequest } from '@/app/api/patients/[anonId]/fhir/MedicationRequest/route'
import { GET as getMedicationDispense } from '@/app/api/patients/[anonId]/fhir/MedicationDispense/route'
import { GET as getObservation } from '@/app/api/patients/[anonId]/fhir/Observation/route'
import { GET as getBundle } from '@/app/api/patients/[anonId]/fhir/Bundle/route'
import { GET as getCcda } from '@/app/api/patients/[anonId]/ccda/route'

const ROUTES = [
  { name: 'Patient', handler: getPatient, auditAction: 'exported FHIR Patient resource' },
  { name: 'AllergyIntolerance', handler: getAllergyIntolerance, auditAction: 'exported FHIR AllergyIntolerance bundle' },
  { name: 'Condition', handler: getCondition, auditAction: 'exported FHIR Condition bundle' },
  { name: 'MedicationRequest', handler: getMedicationRequest, auditAction: 'exported FHIR MedicationRequest bundle' },
  { name: 'MedicationDispense', handler: getMedicationDispense, auditAction: 'exported FHIR MedicationDispense bundle' },
  { name: 'Observation', handler: getObservation, auditAction: 'exported FHIR Observation bundle' },
  { name: 'Bundle', handler: getBundle, auditAction: 'exported full FHIR Bundle' },
  { name: 'CCDA', handler: getCcda, auditAction: 'exported C-CDA document' },
] as const

const EMPTY_BUNDLE_ROUTES = [
  { name: 'AllergyIntolerance', handler: getAllergyIntolerance },
  { name: 'Condition', handler: getCondition },
  { name: 'MedicationRequest', handler: getMedicationRequest },
  { name: 'MedicationDispense', handler: getMedicationDispense },
  { name: 'Observation', handler: getObservation },
] as const

function req() {
  return new Request('http://localhost')
}

function callRoute(handler: (request: Request, ctx: { params: Promise<{ anonId: string }> }) => Promise<Response>, anonId: string) {
  return handler(req(), { params: Promise.resolve({ anonId }) })
}

const createdPatientIds: string[] = []
const createdAllergyIds: number[] = []
const createdDiagnosisIds: number[] = []

let patientAId: string
let patientBId: string
let patientEmptyId: string

beforeAll(async () => {
  const db = getDb()

  const [patientA] = await db.insert(patients).values({
    id: 'RD-FHIR-ROUTES-A', name: 'Route Patient A', dob: '1980-01-01',
  }).returning()
  createdPatientIds.push(patientA.id)
  patientAId = patientA.id

  const [patientB] = await db.insert(patients).values({
    id: 'RD-FHIR-ROUTES-B', name: 'Route Patient B', dob: '1981-01-01',
  }).returning()
  createdPatientIds.push(patientB.id)
  patientBId = patientB.id

  const [patientEmpty] = await db.insert(patients).values({
    id: 'RD-FHIR-ROUTES-EMPTY', name: 'Route Patient Empty', dob: '1982-01-01',
  }).returning()
  createdPatientIds.push(patientEmpty.id)
  patientEmptyId = patientEmpty.id

  const [allergyA] = await db.insert(allergies).values({
    patientId: patientA.id, allergen: 'Penicillin-RouteA', reaction: 'Hives', severity: 'moderate',
  }).returning()
  createdAllergyIds.push(allergyA.id)

  const [allergyB] = await db.insert(allergies).values({
    patientId: patientB.id, allergen: 'Latex-RouteB', reaction: 'Rash', severity: 'mild',
  }).returning()
  createdAllergyIds.push(allergyB.id)

  const [diagnosisA] = await db.insert(diagnoses).values({
    patientId: patientA.id, code: 'J45.909', description: 'Asthma-RouteA', date: '2024-01-01',
  }).returning()
  createdDiagnosisIds.push(diagnosisA.id)

  const [diagnosisB] = await db.insert(diagnoses).values({
    patientId: patientB.id, code: 'E11.9', description: 'Diabetes-RouteB', date: '2024-01-01',
  }).returning()
  createdDiagnosisIds.push(diagnosisB.id)
})

afterAll(async () => {
  const db = getDb()
  while (createdAllergyIds.length > 0) await db.delete(allergies).where(eq(allergies.id, createdAllergyIds.pop()!))
  while (createdDiagnosisIds.length > 0) await db.delete(diagnoses).where(eq(diagnoses.id, createdDiagnosisIds.pop()!))
  while (createdPatientIds.length > 0) await db.delete(patients).where(eq(patients.id, createdPatientIds.pop()!))
})

// The real route handlers write auditLog rows against the shared dev DB.
// Remove only the rows written for this file's own throwaway patients --
// never by action string, which would also delete real compliance records
// of genuine exports (audit_log is append-only). Keyed to the three
// fixed test-only ids (not createdPatientIds, which the patient cleanup
// empties) so the result does not depend on afterAll hook order.
const TEST_PATIENT_IDS = ['RD-FHIR-ROUTES-A', 'RD-FHIR-ROUTES-B', 'RD-FHIR-ROUTES-EMPTY']
afterAll(async () => {
  await getDb().delete(auditLog).where(inArray(auditLog.patientId, TEST_PATIENT_IDS))
})

afterEach(() => {
  sessionRole = 'crc'
})

describe('FHIR export routes -- session gating', () => {
  it('returns 401 from every route when there is no authenticated session', async () => {
    sessionRole = null
    for (const { handler } of ROUTES) {
      const res = await callRoute(handler, patientAId)
      expect(res.status).toBe(401)
    }
  })

  it('403s frontdesk on all 8 routes (FHIR/C-CDA is CLINICAL_ROLES only)', async () => {
    for (const role of ['frontdesk', 'pharmacy', 'billing', 'labs'] as const) {
      sessionRole = role
      for (const { name, handler } of ROUTES) {
        const res = await callRoute(handler, patientAId)
        expect(res.status, `${name} as ${role}`).toBe(403)
        expect(await res.json(), `${name} body as ${role}`).toEqual({ error: 'Forbidden' })
      }
    }
  })

  it('returns 200 from every route for a crc session', async () => {
    sessionRole = 'crc'
    for (const { handler } of ROUTES) {
      const res = await callRoute(handler, patientAId)
      expect(res.status).toBe(200)
    }
  })
})

describe('FHIR export routes -- patient scoping (two patients never cross)', () => {
  it('AllergyIntolerance for patientA contains only patientA\'s allergen', async () => {
    const resA = await callRoute(getAllergyIntolerance, patientAId)
    const bodyA = await resA.json()
    const textA = JSON.stringify(bodyA)
    expect(textA).toContain('Penicillin-RouteA')
    expect(textA).not.toContain('Latex-RouteB')

    const resB = await callRoute(getAllergyIntolerance, patientBId)
    const bodyB = await resB.json()
    const textB = JSON.stringify(bodyB)
    expect(textB).toContain('Latex-RouteB')
    expect(textB).not.toContain('Penicillin-RouteA')
  })

  it('Condition for patientA contains only patientA\'s diagnosis', async () => {
    const resA = await callRoute(getCondition, patientAId)
    const bodyA = await resA.json()
    const textA = JSON.stringify(bodyA)
    expect(textA).toContain('Asthma-RouteA')
    expect(textA).not.toContain('Diabetes-RouteB')

    const resB = await callRoute(getCondition, patientBId)
    const bodyB = await resB.json()
    const textB = JSON.stringify(bodyB)
    expect(textB).toContain('Diabetes-RouteB')
    expect(textB).not.toContain('Asthma-RouteA')
  })

  it('Bundle for patientA contains only patientA\'s allergen and diagnosis', async () => {
    const resA = await callRoute(getBundle, patientAId)
    const bodyA = await resA.json()
    const textA = JSON.stringify(bodyA)
    expect(textA).toContain('Penicillin-RouteA')
    expect(textA).toContain('Asthma-RouteA')
    expect(textA).not.toContain('Latex-RouteB')
    expect(textA).not.toContain('Diabetes-RouteB')

    const resB = await callRoute(getBundle, patientBId)
    const bodyB = await resB.json()
    const textB = JSON.stringify(bodyB)
    expect(textB).toContain('Latex-RouteB')
    expect(textB).toContain('Diabetes-RouteB')
    expect(textB).not.toContain('Penicillin-RouteA')
    expect(textB).not.toContain('Asthma-RouteA')
  })
})

describe('FHIR export routes -- empty Bundle, not an error', () => {
  it('every Bundle-returning resource route for a data-free patient returns an empty, well-formed Bundle', async () => {
    for (const { handler } of EMPTY_BUNDLE_ROUTES) {
      const res = await callRoute(handler, patientEmptyId)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ resourceType: 'Bundle', type: 'collection', total: 0, entry: [] })
    }
  })

  it('/fhir/Bundle for a data-free patient returns total: 1 (just the Patient resource)', async () => {
    const res = await callRoute(getBundle, patientEmptyId)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resourceType).toBe('Bundle')
    expect(body.total).toBe(1)
    expect(body.entry).toHaveLength(1)
    expect(body.entry[0].resource.resourceType).toBe('Patient')
  })
})

describe('FHIR export routes -- unknown anonId', () => {
  it('returns 404, not a 500, from every route for an unknown anonId', async () => {
    for (const { handler } of ROUTES) {
      const res = await callRoute(handler, 'RD-FHIR-ROUTES-DOES-NOT-EXIST')
      expect(res.status).toBe(404)
    }
  })
})

describe('FHIR export routes -- /fhir/Patient shape', () => {
  it('returns a bare Patient resource, not a Bundle', async () => {
    const res = await callRoute(getPatient, patientAId)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resourceType).toBe('Patient')
    expect(body.entry).toBeUndefined()
  })
})

describe('C-CDA export route -- /ccda', () => {
  it('returns 401 when there is no authenticated session', async () => {
    sessionRole = null
    const res = await callRoute(getCcda, patientAId)
    expect(res.status).toBe(401)
  })

  it('returns 404, not a 500, for an unknown anonId', async () => {
    const res = await callRoute(getCcda, 'RD-FHIR-ROUTES-DOES-NOT-EXIST')
    expect(res.status).toBe(404)
  })

  it('returns XML with attachment headers', async () => {
    const res = await callRoute(getCcda, patientAId)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/^(application|text)\/xml/)
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="/)
  })

  it('contains only patientA\'s allergen and diagnosis, never patientB\'s', async () => {
    const resA = await callRoute(getCcda, patientAId)
    const xmlA = await resA.text()
    expect(xmlA).toContain('Penicillin-RouteA')
    expect(xmlA).toContain('Asthma-RouteA')
    expect(xmlA).not.toContain('Latex-RouteB')
    expect(xmlA).not.toContain('Diabetes-RouteB')

    const resB = await callRoute(getCcda, patientBId)
    const xmlB = await resB.text()
    expect(xmlB).toContain('Latex-RouteB')
    expect(xmlB).toContain('Diabetes-RouteB')
    expect(xmlB).not.toContain('Penicillin-RouteA')
    expect(xmlB).not.toContain('Asthma-RouteA')
  })
})

describe('FHIR export routes -- downloads, not inline JSON', () => {
  it('every /fhir/* route sets Content-Disposition: attachment with a resource-specific filename', async () => {
    for (const { name, handler } of ROUTES) {
      if (name === 'CCDA') continue // covered by its own "attachment headers" test above
      const res = await callRoute(handler, patientAId)
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toMatch(/^application\/fhir\+json/)
      expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="RD-FHIR-ROUTES-A-fhir-.+\.json"$/)
    }
  })
})

describe('spec §5 -- every export route audit-logs its own action string', () => {
  it('logs the expected auditLog action string for every one of the 8 export routes', async () => {
    for (const { handler, auditAction } of ROUTES) {
      await callRoute(handler, patientAId)
      // Scoped to this route's own action string, not "the globally latest
      // row" -- the shared dev DB has concurrent writers (other
      // branches/worktrees), so an unscoped "latest row" read is racy
      // (matching tests/api/trials.test.ts's and tests/api/users.test.ts's
      // own convention for this).
      const [latest] = await getDb().select().from(auditLog).where(eq(auditLog.action, auditAction)).orderBy(desc(auditLog.id)).limit(1)
      expect(latest?.action).toBe(auditAction)
      expect(latest?.patientId).toBe(patientAId)
    }
  })
})
