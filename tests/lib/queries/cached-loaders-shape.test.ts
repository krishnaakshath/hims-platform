// P2-03 regression: every getOrSetCache loader returns a value that survives
// the Redis JSON round-trip unchanged, i.e. a cache HIT has exactly the shape
// of a cache MISS (no Date that comes back as a string and crashes a later
// `.getTime()`). getOrSetCache normalises centrally (src/lib/cache.ts); this
// runs every loader against the live DB with Redis switched off.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { desc } from 'drizzle-orm'

beforeAll(() => { vi.stubEnv('KV_REST_API_URL', ''); vi.stubEnv('KV_REST_API_TOKEN', '') })
afterAll(() => { vi.unstubAllEnvs() })

import { getDb } from '@/db/client'
import { charges, patients } from '@/db/schema'
import { listFaxes } from '@/lib/queries/faxes'
import { getBillingAnalyticsData } from '@/lib/queries/billing-analytics'
import { getArDashboardData } from '@/lib/queries/ar-dashboard'
import { listAllAppointmentsReport, listUnsignedNotesReport, listAllEncountersReport, listInsuranceCollectionsReport } from '@/lib/queries/reports'
import { listBroadcasts } from '@/lib/queries/broadcasts'
import { listInsuranceClaims } from '@/lib/queries/insurance-claims'
import { listPatientStatements } from '@/lib/queries/patient-statements'
import { listActiveProviders } from '@/lib/queries/providers'
import { listPatientsWithStatus, getPatientDetail } from '@/lib/queries/patients'
import { getDashboardData } from '@/lib/queries/dashboard'
import { listCharges, getCharge } from '@/lib/queries/charges'
import { getPipelinePerformance, getPipelineTrend } from '@/lib/queries/pipeline-dashboard'
import { listFormTemplates } from '@/lib/queries/form-templates'
import { listDocuments } from '@/lib/queries/documents'
import { listPatientCollections } from '@/lib/queries/patient-collections'
import { listWorkbookRows } from '@/lib/queries/workbook'
import { listReviews } from '@/lib/queries/reviews'

function datePaths(v: unknown, path = '$', out: string[] = []): string[] {
  if (v instanceof Date) out.push(path)
  else if (Array.isArray(v)) v.forEach((x, i) => datePaths(x, `${path}[${i}]`, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) datePaths(x, `${path}.${k}`, out)
  return out
}

const range = { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-12-31T00:00:00Z') }
const LOADERS: [string, () => Promise<unknown>][] = [
  ['listFaxes', () => listFaxes()],
  ['getBillingAnalyticsData', () => getBillingAnalyticsData()],
  ['getArDashboardData', () => getArDashboardData()],
  ['listAllAppointmentsReport', () => listAllAppointmentsReport()],
  ['listUnsignedNotesReport', () => listUnsignedNotesReport()],
  ['listAllEncountersReport', () => listAllEncountersReport()],
  ['listInsuranceCollectionsReport', () => listInsuranceCollectionsReport()],
  ['listBroadcasts', () => listBroadcasts()],
  ['listInsuranceClaims', () => listInsuranceClaims()],
  ['listPatientStatements', () => listPatientStatements()],
  ['listActiveProviders', () => listActiveProviders()],
  ['listPatientsWithStatus', () => listPatientsWithStatus(null)],
  ['getPatientDetail', async () => {
    const [p] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    return p ? getPatientDetail(p.id) : null
  }],
  ['getDashboardData', () => getDashboardData()],
  ['listCharges', () => listCharges()],
  ['getCharge', async () => {
    const [c] = await getDb().select({ id: charges.id }).from(charges).orderBy(desc(charges.id)).limit(1)
    return c ? getCharge(c.id) : null
  }],
  ['getPipelinePerformance', () => getPipelinePerformance(range)],
  ['getPipelineTrend', () => getPipelineTrend(range)],
  ['listFormTemplates', () => listFormTemplates()],
  ['listDocuments', () => listDocuments()],
  ['listPatientCollections', () => listPatientCollections()],
  ['listWorkbookRows', () => listWorkbookRows()],
  ['listReviews', () => listReviews({})],
]

describe.each(LOADERS)('%s', (_name, load) => {
  it('returns no Date anywhere, so a cache hit equals a cache miss', { timeout: 30000 }, async () => {
    const fresh = await load()
    expect(datePaths(fresh).slice(0, 5)).toEqual([])
    expect(JSON.parse(JSON.stringify(fresh ?? null))).toEqual(fresh ?? null)
  })
})
