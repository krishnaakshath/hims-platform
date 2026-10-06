import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { and, eq, ne } from 'drizzle-orm'
import * as auth from '@/lib/auth'
import { getDb } from '@/db/client'
import { patients, providers, staffMembers, medications, medicationEpisodes } from '@/db/schema'
import { invalidateCache, providersListCacheKey } from '@/lib/cache'

type Role = 'admin' | 'pi' | 'crc' | 'frontdesk'
let sessionRole: Role = 'admin'
let sessionName = 'Test Admin'
let sessionUserId: number | null = null

// Following lab-orders-routes.test.ts's pattern: a hoisted vi.mock closing
// over mutable module-scope lets. This is the first route test in the repo
// whose route reads `session.userId`, so the factory carries it too.
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => ({ role: sessionRole, name: sessionName, userId: sessionUserId })),
}))

import { POST as createPrescriptionRoute } from '@/app/api/patients/[anonId]/prescriptions/route'
import { PATCH as stopPrescriptionRoute } from '@/app/api/patients/[anonId]/prescriptions/[id]/route'

let patientAId: string
let patientBId: string
let kunamUserId: number
let kunamProviderId: number
let otherProviderId: number
let medicationIdSeed: number

// NOTE ON LOOKUP STRATEGY: per the task brief and prior tasks' review notes
// (tests/lib/provider-identity.test.ts), this shared dev DB's `users` row
// for Dr. Rajiv Kunam may carry a different email than the seeded
// `pi@<SEED_EMAIL_DOMAIN>` (seed.ts's early-return-when-already-seeded
// path never ran the fixed-email insert here). Resolving by staff name +
// the real userId/providerId links -- the same relational shape
// resolveSessionProvider walks -- is robust to that drift, so we look Kunam
// up that way instead of by the seeded email.
beforeAll(async () => {
  const db = getDb()

  const patientRows = await db.select({ id: patients.id }).from(patients).limit(2)
  if (patientRows.length < 2) throw new Error('Need at least two seeded patients for this suite')
  patientAId = patientRows[0].id
  patientBId = patientRows[1].id

  const [kunamStaff] = await db.select().from(staffMembers).where(eq(staffMembers.name, 'Dr. Rajiv Kunam'))
  if (!kunamStaff || kunamStaff.userId == null || kunamStaff.providerId == null) {
    throw new Error('Seeded staff row for Dr. Rajiv Kunam not found, or missing userId/providerId')
  }
  kunamUserId = kunamStaff.userId
  kunamProviderId = kunamStaff.providerId

  const [otherProvider] = await db.select().from(providers).where(and(eq(providers.isActive, true), ne(providers.id, kunamProviderId))).limit(1)
  if (!otherProvider) throw new Error('Need a second active seeded provider distinct from Dr. Kunam')
  otherProviderId = otherProvider.id

  const [medicationRow] = await db.select({ id: medications.id }).from(medications).limit(1)
  if (!medicationRow) throw new Error('Need at least one seeded medication')
  medicationIdSeed = medicationRow.id
})

const trackedEpisodeIds: number[] = []
let otherProviderActiveSnapshot: boolean | null = null

afterEach(async () => {
  sessionRole = 'admin'
  sessionName = 'Test Admin'
  sessionUserId = null

  const db = getDb()
  while (trackedEpisodeIds.length > 0) {
    const id = trackedEpisodeIds.pop()!
    await db.delete(medicationEpisodes).where(eq(medicationEpisodes.id, id))
  }

  if (otherProviderActiveSnapshot !== null) {
    await db.update(providers).set({ isActive: otherProviderActiveSnapshot }).where(eq(providers.id, otherProviderId))
    await invalidateCache(providersListCacheKey())
    otherProviderActiveSnapshot = null
  }
})

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    medicationId: medicationIdSeed,
    name: 'Sertraline',
    medicationClass: 'SSRI',
    dose: '50mg',
    frequencyPerDay: 1,
    durationDays: 30,
    startDate: '2026-09-29',
    instructions: 'Take with food',
    ...overrides,
  }
}

function postRequest(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) })
}

async function episodeCount(patientId: string): Promise<number> {
  const rows = await getDb().select({ id: medicationEpisodes.id }).from(medicationEpisodes).where(eq(medicationEpisodes.patientId, patientId))
  return rows.length
}

describe('POST /api/patients/[anonId]/prescriptions', () => {
  it('pi with a linked provider gets 201 attributed to that provider', async () => {
    sessionRole = 'pi'
    sessionName = 'Dr. R. Kunam'
    sessionUserId = kunamUserId

    const res = await createPrescriptionRoute(postRequest(validPayload()) as never, { params: Promise.resolve({ anonId: patientAId }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    trackedEpisodeIds.push(body.id)
    expect(body.prescribedByProviderId).toBe(kunamProviderId)
    expect(body.status).toBe('active')
    expect(body.prescribedAt).toBeTruthy()
    expect(body.enteredByName).toBe('Dr. R. Kunam')
  })

  it('pi with no resolvable provider gets 403 and writes nothing', async () => {
    sessionRole = 'pi'
    sessionName = 'Someone Unlinked'
    sessionUserId = null

    const before = await episodeCount(patientAId)
    const res = await createPrescriptionRoute(postRequest(validPayload()) as never, { params: Promise.resolve({ anonId: patientAId }) })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Could not resolve your provider identity. Ask an admin to link your account to a provider in the Staff Directory.')
    expect(await episodeCount(patientAId)).toBe(before)
  })

  it('admin with no resolvable provider and no onBehalfOfProviderId gets 400 and writes nothing', async () => {
    sessionRole = 'admin'
    sessionUserId = null

    const before = await episodeCount(patientAId)
    const res = await createPrescriptionRoute(postRequest(validPayload()) as never, { params: Promise.resolve({ anonId: patientAId }) })
    expect(res.status).toBe(400)
    expect(await episodeCount(patientAId)).toBe(before)
  })

  it('admin with a valid onBehalfOfProviderId gets 201 attributed to the chosen provider, entered by the admin', async () => {
    sessionRole = 'admin'
    sessionName = 'Sam Patel'
    sessionUserId = null

    const res = await createPrescriptionRoute(postRequest(validPayload({ onBehalfOfProviderId: otherProviderId })) as never, { params: Promise.resolve({ anonId: patientAId }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    trackedEpisodeIds.push(body.id)
    expect(body.prescribedByProviderId).toBe(otherProviderId)
    expect(body.enteredByName).toBe('Sam Patel')
  })

  it('admin with an onBehalfOfProviderId naming a nonexistent provider gets 400 and writes nothing', async () => {
    sessionRole = 'admin'
    sessionUserId = null

    const before = await episodeCount(patientAId)
    const res = await createPrescriptionRoute(postRequest(validPayload({ onBehalfOfProviderId: 9_999_999 })) as never, { params: Promise.resolve({ anonId: patientAId }) })
    expect(res.status).toBe(400)
    expect(await episodeCount(patientAId)).toBe(before)
  })

  it('admin with an onBehalfOfProviderId naming an inactive provider gets 400', async () => {
    sessionRole = 'admin'
    sessionUserId = null

    const [current] = await getDb().select({ isActive: providers.isActive }).from(providers).where(eq(providers.id, otherProviderId))
    otherProviderActiveSnapshot = current.isActive
    await getDb().update(providers).set({ isActive: false }).where(eq(providers.id, otherProviderId))
    // listActiveProviders() is cached for 60s (providers:list) -- flipping
    // the DB row alone leaves a stale cached "active" roster in place.
    await invalidateCache(providersListCacheKey())

    const before = await episodeCount(patientAId)
    const res = await createPrescriptionRoute(postRequest(validPayload({ onBehalfOfProviderId: otherProviderId })) as never, { params: Promise.resolve({ anonId: patientAId }) })
    expect(res.status).toBe(400)
    expect(await episodeCount(patientAId)).toBe(before)
  })

  it('onBehalfOfProviderId is silently ignored when the session already resolves a provider', async () => {
    sessionRole = 'pi'
    sessionName = 'Dr. R. Kunam'
    sessionUserId = kunamUserId

    const res = await createPrescriptionRoute(postRequest(validPayload({ onBehalfOfProviderId: otherProviderId })) as never, { params: Promise.resolve({ anonId: patientAId }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    trackedEpisodeIds.push(body.id)
    expect(body.prescribedByProviderId).toBe(kunamProviderId)
  })

  it('crc gets 403', async () => {
    sessionRole = 'crc'
    const res = await createPrescriptionRoute(postRequest(validPayload()) as never, { params: Promise.resolve({ anonId: patientAId }) })
    expect(res.status).toBe(403)
  })

  it('frontdesk gets 403', async () => {
    sessionRole = 'frontdesk'
    const res = await createPrescriptionRoute(postRequest(validPayload()) as never, { params: Promise.resolve({ anonId: patientAId }) })
    expect(res.status).toBe(403)
  })

  it('no session gets 401', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const res = await createPrescriptionRoute(postRequest(validPayload()) as never, { params: Promise.resolve({ anonId: patientAId }) })
    expect(res.status).toBe(401)
  })

  it('rejects an unknown field (mass-assignment guard)', async () => {
    sessionRole = 'pi'
    sessionUserId = kunamUserId
    const res = await createPrescriptionRoute(postRequest(validPayload({ nickname: 'x' })) as never, { params: Promise.resolve({ anonId: patientAId }) })
    expect(res.status).toBe(400)
  })

  it.each(['prescribedByProviderId', 'prescribedAt', 'enteredByName', 'status'])('rejects a client-supplied %s (.strict())', async (field) => {
    sessionRole = 'pi'
    sessionUserId = kunamUserId
    const extra: Record<string, unknown> = {}
    extra[field] = field === 'prescribedByProviderId' ? otherProviderId : field === 'prescribedAt' ? new Date().toISOString() : field === 'status' ? 'inactive' : 'Someone Else'
    const res = await createPrescriptionRoute(postRequest(validPayload(extra)) as never, { params: Promise.resolve({ anonId: patientAId }) })
    expect(res.status).toBe(400)
  })

  it.each([
    { frequencyPerDay: 0 },
    { frequencyPerDay: 7 },
    { durationDays: 0 },
    { durationDays: 400 },
  ])('rejects out-of-range structural bounds %j', async (overrides) => {
    sessionRole = 'pi'
    sessionUserId = kunamUserId
    const res = await createPrescriptionRoute(postRequest(validPayload(overrides)) as never, { params: Promise.resolve({ anonId: patientAId }) })
    expect(res.status).toBe(400)
  })

  it('rejects a malformed startDate', async () => {
    sessionRole = 'pi'
    sessionUserId = kunamUserId
    const res = await createPrescriptionRoute(postRequest(validPayload({ startDate: '09/29/2026' })) as never, { params: Promise.resolve({ anonId: patientAId }) })
    expect(res.status).toBe(400)
  })

  it('rejects instructions over 500 characters', async () => {
    sessionRole = 'pi'
    sessionUserId = kunamUserId
    const res = await createPrescriptionRoute(postRequest(validPayload({ instructions: 'a'.repeat(501) })) as never, { params: Promise.resolve({ anonId: patientAId }) })
    expect(res.status).toBe(400)
  })

  it('the off-catalog path works: medicationId omitted, free-text name/medicationClass', async () => {
    sessionRole = 'pi'
    sessionUserId = kunamUserId
    const payload = validPayload({ name: 'Compounded Tincture', medicationClass: 'Other' }) as Record<string, unknown>
    delete payload.medicationId
    const res = await createPrescriptionRoute(postRequest(payload) as never, { params: Promise.resolve({ anonId: patientAId }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    trackedEpisodeIds.push(body.id)
    expect(body.medicationId).toBeNull()
  })
})

describe('PATCH /api/patients/[anonId]/prescriptions/[id]', () => {
  async function seedActivePrescription(patientId: string) {
    const prevRole = sessionRole
    const prevName = sessionName
    const prevUserId = sessionUserId
    sessionRole = 'pi'
    sessionName = 'Dr. R. Kunam'
    sessionUserId = kunamUserId

    const res = await createPrescriptionRoute(postRequest(validPayload()) as never, { params: Promise.resolve({ anonId: patientId }) })
    const body = await res.json()
    trackedEpisodeIds.push(body.id)

    sessionRole = prevRole
    sessionName = prevName
    sessionUserId = prevUserId
    return body.id as number
  }

  function patchRequest(body?: unknown) {
    return new Request('http://localhost', { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) })
  }

  it('pi stops an active prescription', async () => {
    const episodeId = await seedActivePrescription(patientAId)
    sessionRole = 'pi'
    sessionUserId = kunamUserId
    const res = await stopPrescriptionRoute(patchRequest({ stopDate: '2026-09-30' }) as never, { params: Promise.resolve({ anonId: patientAId, id: String(episodeId) }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('inactive')
    expect(body.stopDate).toBeTruthy()
  })

  it('no request body at all still succeeds and defaults stopDate to today', async () => {
    const episodeId = await seedActivePrescription(patientAId)
    sessionRole = 'pi'
    sessionUserId = kunamUserId
    const res = await stopPrescriptionRoute(patchRequest(undefined) as never, { params: Promise.resolve({ anonId: patientAId, id: String(episodeId) }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('inactive')
    expect(body.stopDate).toBe(new Date().toISOString().slice(0, 10))
  })

  it('a second PATCH on the same row returns 409', async () => {
    const episodeId = await seedActivePrescription(patientAId)
    sessionRole = 'pi'
    sessionUserId = kunamUserId
    const first = await stopPrescriptionRoute(patchRequest(undefined) as never, { params: Promise.resolve({ anonId: patientAId, id: String(episodeId) }) })
    expect(first.status).toBe(200)
    const second = await stopPrescriptionRoute(patchRequest(undefined) as never, { params: Promise.resolve({ anonId: patientAId, id: String(episodeId) }) })
    expect(second.status).toBe(409)
  })

  it('PATCH on an episode belonging to another patient returns 404', async () => {
    const episodeId = await seedActivePrescription(patientAId)
    sessionRole = 'pi'
    sessionUserId = kunamUserId
    const res = await stopPrescriptionRoute(patchRequest(undefined) as never, { params: Promise.resolve({ anonId: patientBId, id: String(episodeId) }) })
    expect(res.status).toBe(404)
  })

  it('PATCH on an unknown id returns 404', async () => {
    sessionRole = 'pi'
    sessionUserId = kunamUserId
    const res = await stopPrescriptionRoute(patchRequest(undefined) as never, { params: Promise.resolve({ anonId: patientAId, id: '999999999' }) })
    expect(res.status).toBe(404)
  })

  it('a non-numeric id path segment returns 404', async () => {
    sessionRole = 'pi'
    sessionUserId = kunamUserId
    const res = await stopPrescriptionRoute(patchRequest(undefined) as never, { params: Promise.resolve({ anonId: patientAId, id: 'abc' }) })
    expect(res.status).toBe(404)
  })

  it('crc gets 403', async () => {
    const episodeId = await seedActivePrescription(patientAId)
    sessionRole = 'crc'
    const res = await stopPrescriptionRoute(patchRequest(undefined) as never, { params: Promise.resolve({ anonId: patientAId, id: String(episodeId) }) })
    expect(res.status).toBe(403)
  })

  it('frontdesk gets 403', async () => {
    const episodeId = await seedActivePrescription(patientAId)
    sessionRole = 'frontdesk'
    const res = await stopPrescriptionRoute(patchRequest(undefined) as never, { params: Promise.resolve({ anonId: patientAId, id: String(episodeId) }) })
    expect(res.status).toBe(403)
  })

  it('rejects an unknown body field', async () => {
    const episodeId = await seedActivePrescription(patientAId)
    sessionRole = 'pi'
    sessionUserId = kunamUserId
    const res = await stopPrescriptionRoute(patchRequest({ nickname: 'x' }) as never, { params: Promise.resolve({ anonId: patientAId, id: String(episodeId) }) })
    expect(res.status).toBe(400)
  })
})
