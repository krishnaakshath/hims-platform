import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import * as auth from '@/lib/auth'
import { getDb } from '@/db/client'
import { trials } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { ALL_ROLES, CLINICAL_ROLES, TRIAL_CRITERIA_EDIT_ROLES } from '@/lib/role-policy'
import type { Role } from '@/lib/auth'

import { GET as listTrials } from '@/app/api/trials/route'
import { PUT as updateCriteria } from '@/app/api/trials/[trialId]/criteria/route'

const UNAUTHORIZED = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'crc' as const, name: 'Test CRC' })) }
})

// Audit rows are append-only compliance records: mock the writer instead of
// inserting (and then deleting) real rows in the shared DB.
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))

const TRIAL_ID = 'nct-adhd-demo-01'
let original: typeof trials.$inferSelect

// Snapshot the whole seeded row before any test mutates it and restore every
// editable column afterwards (afterEach runs even when a test fails).
const restoreOriginal = () =>
  getDb()
    .update(trials)
    .set({
      diagnosisCodes: original.diagnosisCodes,
      ratingScales: original.ratingScales,
      medicationClasses: original.medicationClasses,
      exclusionDiagnoses: original.exclusionDiagnoses,
      minRatingScaleScore: original.minRatingScaleScore,
      ageMin: original.ageMin,
      ageMax: original.ageMax,
    })
    .where(eq(trials.id, TRIAL_ID))

beforeAll(async () => {
  const [row] = await getDb().select().from(trials).where(eq(trials.id, TRIAL_ID))
  original = row
})
afterEach(async () => {
  await restoreOriginal()
})
afterAll(async () => {
  await restoreOriginal()
})

const asRole = (role: Role) => vi.mocked(auth.requireSession).mockResolvedValue({ role, name: `Test ${role}` } as never)
beforeEach(() => asRole('pi'))

const get = () => listTrials(new NextRequest('http://localhost/api/trials'))
const put = (trialId: string, body: unknown) =>
  updateCriteria(
    new NextRequest(`http://localhost/api/trials/${trialId}/criteria`, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }),
    { params: Promise.resolve({ trialId }) },
  )
const readRow = async () => (await getDb().select().from(trials).where(eq(trials.id, TRIAL_ID)))[0]

describe('GET /api/trials', () => {
  it('returns 401 when there is no authenticated session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce(UNAUTHORIZED())
    expect((await get()).status).toBe(401)
  })

  it.each(CLINICAL_ROLES)('lists all configured trials for %s', async (role) => {
    asRole(role)
    const response = await get()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.trials.length).toBe(2)
    expect(body.trials[0].diagnosisCodes).toBeDefined()
  })

  it.each(ALL_ROLES.filter((r) => !CLINICAL_ROLES.includes(r)))('403s %s with exactly { error: "Forbidden" }', async (role) => {
    asRole(role)
    const response = await get()
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Forbidden' })
  })

  it('writes an audit entry when the trial list is viewed', async () => {
    const { logAudit } = await import('@/lib/audit')
    vi.mocked(logAudit).mockClear()
    await get()
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'viewed trials list', null)
  })
})

describe('PUT /api/trials/[trialId]/criteria', () => {
  const MED = [{ className: 'Stimulant', washoutDays: 21, rule: 'Updated rule', ruleType: 'washout_exclusion' as const }]

  it('returns 401 when there is no authenticated session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce(UNAUTHORIZED())
    expect((await put(TRIAL_ID, { medicationClasses: MED })).status).toBe(401)
  })

  it.each(TRIAL_CRITERIA_EDIT_ROLES)('lets %s update a trial\'s medication classes without affecting other trials', async (role) => {
    asRole(role)
    const response = await put(TRIAL_ID, { medicationClasses: MED })
    expect(response.status).toBe(200)
    expect((await readRow()).medicationClasses).toEqual(MED)

    asRole('crc')
    const { trials: all } = await (await get()).json()
    const other = all.find((t: { id: string }) => t.id !== TRIAL_ID)
    expect(other.medicationClasses).not.toEqual(MED)
  })

  it.each(ALL_ROLES.filter((r) => !TRIAL_CRITERIA_EDIT_ROLES.includes(r)))(
    '403s %s and leaves a known trial row unchanged',
    async (role) => {
      asRole(role)
      const response = await put(TRIAL_ID, { medicationClasses: MED, ageMin: 19 })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'Forbidden' })
      const row = await readRow()
      expect(row.medicationClasses).toEqual(original.medicationClasses)
      expect(row.ageMin).toBe(original.ageMin)
    },
  )

  it('403s a forbidden role before parsing the body (malformed JSON is not a 400 for them)', async () => {
    asRole('crc')
    expect((await put(TRIAL_ID, '{not json')).status).toBe(403)
  })

  it('returns 404 JSON for an unknown trial', async () => {
    const response = await put('probe-no-trial', { ageMin: 18 })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Trial not found' })
  })

  it('returns 400 JSON (not 500) for a malformed JSON body', async () => {
    const response = await put(TRIAL_ID, '{not json')
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid JSON' })
  })

  it('rejects ageMax below ageMin in the same payload', async () => {
    const response = await put(TRIAL_ID, { ageMin: 40, ageMax: 30 })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'ageMax must be greater than or equal to ageMin' })
    expect((await readRow()).ageMin).toBe(original.ageMin)
  })

  it('rejects an ageMax below the stored ageMin', async () => {
    const response = await put(TRIAL_ID, { ageMax: original.ageMin - 1 })
    expect(response.status).toBe(400)
    expect((await readRow()).ageMax).toBe(original.ageMax)
  })

  it('rejects an ageMin above the stored ageMax', async () => {
    const response = await put(TRIAL_ID, { ageMin: original.ageMax + 1 })
    expect(response.status).toBe(400)
    expect((await readRow()).ageMin).toBe(original.ageMin)
  })

  it('accepts a single bound that is consistent with the stored other bound', async () => {
    const response = await put(TRIAL_ID, { ageMax: original.ageMin })
    expect(response.status).toBe(200)
    expect((await readRow()).ageMax).toBe(original.ageMin)
  })

  it('returns 400 for an empty body', async () => {
    const response = await put(TRIAL_ID, {})
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'No criteria fields to update' })
  })

  it('rejects a payload containing a field outside the criteria allowlist (mass-assignment attempt)', async () => {
    const response = await put(TRIAL_ID, { id: 'hijacked-id', createdAt: '2000-01-01' })
    expect(response.status).toBe(400)
    const [hijacked] = await getDb().select().from(trials).where(eq(trials.id, 'hijacked-id'))
    expect(hijacked).toBeUndefined()
    expect((await readRow()).id).toBe(TRIAL_ID)
  })
})

describe('PUT criteria string and washout validation', () => {
  const BLANKS = ['', '   ']
  const bad: Array<[string, unknown]> = []
  for (const v of BLANKS) {
    bad.push([`diagnosisCodes.code ${JSON.stringify(v)}`, { diagnosisCodes: [{ code: v, description: 'd' }] }])
    bad.push([`diagnosisCodes.description ${JSON.stringify(v)}`, { diagnosisCodes: [{ code: 'F90', description: v }] }])
    bad.push([`ratingScales.name ${JSON.stringify(v)}`, { ratingScales: [{ name: v, description: 'd' }] }])
    bad.push([`ratingScales.description ${JSON.stringify(v)}`, { ratingScales: [{ name: 'n', description: v }] }])
    bad.push([`exclusionDiagnoses.code ${JSON.stringify(v)}`, { exclusionDiagnoses: [{ code: v, description: 'd' }] }])
    bad.push([`exclusionDiagnoses.description ${JSON.stringify(v)}`, { exclusionDiagnoses: [{ code: 'c', description: v }] }])
    bad.push([`medicationClasses.className ${JSON.stringify(v)}`, { medicationClasses: [{ className: v, washoutDays: 7, rule: 'r', ruleType: 'washout_exclusion' }] }])
    bad.push([`medicationClasses.rule ${JSON.stringify(v)}`, { medicationClasses: [{ className: 'c', washoutDays: 7, rule: v, ruleType: 'washout_exclusion' }] }])
  }
  it.each(bad)('rejects blank %s and leaves the row unchanged', async (_label, body) => {
    const response = await put(TRIAL_ID, body)
    expect(response.status).toBe(400)
    const row = await readRow()
    expect(row.diagnosisCodes).toEqual(original.diagnosisCodes)
    expect(row.ratingScales).toEqual(original.ratingScales)
    expect(row.medicationClasses).toEqual(original.medicationClasses)
    expect(row.exclusionDiagnoses).toEqual(original.exclusionDiagnoses)
  })

  const med = (washoutDays: number) => ({ medicationClasses: [{ className: 'Stimulant', washoutDays, rule: 'r', ruleType: 'required_stable' as const }] })
  it.each([-1, 2.5])('rejects washoutDays %s', async (n) => {
    expect((await put(TRIAL_ID, med(n))).status).toBe(400)
    expect((await readRow()).medicationClasses).toEqual(original.medicationClasses)
  })
  it.each([0, 14])('accepts washoutDays %s', async (n) => {
    expect((await put(TRIAL_ID, med(n))).status).toBe(200)
    expect((await readRow()).medicationClasses).toEqual(med(n).medicationClasses)
  })

  it('still accepts a valid full payload', async () => {
    const full = {
      diagnosisCodes: [{ code: 'F90.0', description: 'ADHD' }],
      ratingScales: [{ name: 'ADHD-RS', description: 'Rating scale' }],
      medicationClasses: [{ className: 'Stimulant', washoutDays: 21, rule: 'Washout', ruleType: 'washout_exclusion' as const }],
      exclusionDiagnoses: [{ code: 'F20', description: 'Schizophrenia' }],
      minRatingScaleScore: 24,
      ageMin: original.ageMin,
      ageMax: original.ageMax,
    }
    expect((await put(TRIAL_ID, full)).status).toBe(200)
  })
})
