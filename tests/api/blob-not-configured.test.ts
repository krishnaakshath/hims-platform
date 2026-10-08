// @vitest-environment node
// A deployment without a Blob store (BLOB_READ_WRITE_TOKEN unset) must answer
// the routes that read or write stored files with a generic 503, never a 500,
// and say what is missing in ONE server-side [config] log line. The client
// never sees an env var name.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'admin', name: 'Test admin', userId: null })) }
})
vi.mock('@/lib/patient-session', () => ({ requirePatientSession: vi.fn(async () => ({ patientId: 'RD-0001' })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))

const BLOB_URL = 'https://store.private.blob.vercel-storage.com/lab-reports/5/x.pdf'
vi.mock('@/lib/queries/lab-reports', () => ({
  // The real release renders first and then stores the PDF through putPrivateBlob.
  releaseLabReport: vi.fn(async () => {
    const { putPrivateBlob } = await import('@/lib/blob-store')
    await putPrivateBlob('lab-reports/1/x.pdf', new Uint8Array([37]), 'application/pdf')
    throw new Error('unreachable')
  }),
  getLabReportForDownload: vi.fn(async () => ({ id: 41, patientId: 'RD-0001', reportNumber: 'LR-2099-000007', blobUrl: BLOB_URL, supersededAt: null })),
}))
vi.mock('@/lib/queries/claim-documents', () => ({
  getClaimDocumentBlob: vi.fn(async () => ({ url: BLOB_URL, claimId: 3, patientId: 'RD-0001', contentType: 'application/pdf', title: 'x' })),
}))
vi.mock('@/lib/queries/documents', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queries/documents')>('@/lib/queries/documents')
  return { ...actual, getDocument: vi.fn(async () => ({ id: 9, name: 'scan.pdf', patientId: 'RD-0001', labOrderId: null, fileUrl: BLOB_URL })) }
})

import { POST as releaseReport } from '@/app/api/lab-requisitions/[id]/report/route'
import { GET as staffDownload } from '@/app/api/lab-reports/[id]/download/route'
import { GET as portalDownload } from '@/app/api/patient-portal/lab-reports/[id]/download/route'
import { GET as claimDocument } from '@/app/api/rcm/claim-documents/[id]/route'
import { GET as documentDownload } from '@/app/api/documents/[id]/download/route'
import { POST as insuranceCardUpload } from '@/app/api/patients/[anonId]/insurance-card/route'

const ENV_NAMES = /BLOB|TOKEN|KV_REST|DATABASE_URL/
const req = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://localhost${path}`, init)
const idParams = (id: string) => ({ params: Promise.resolve({ id }) })

let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', '')
  vi.stubEnv('BLOB_STORE_ID', '')
  log = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function expect503(res: Response, feature: string) {
  expect(res.status).toBe(503)
  const body = await res.json()
  expect(body).toEqual({ error: 'Service temporarily unavailable' })
  expect(JSON.stringify(body)).not.toMatch(ENV_NAMES)
  expect(log).toHaveBeenCalledTimes(1)
  expect(log.mock.calls[0][0]).toBe(`[config] BLOB_READ_WRITE_TOKEN not configured: ${feature} is unavailable`)
}

describe('blob store not configured', () => {
  it('lab report release answers 503, not 500', async () => {
    await expect503(await releaseReport(req('/api/lab-requisitions/7/report', { method: 'POST' }), idParams('7')), 'lab report release')
  })

  it('staff lab report download answers 503', async () => {
    await expect503(await staffDownload(req('/api/lab-reports/41/download'), idParams('41')), 'lab report download')
  })

  it('patient portal lab report download answers 503', async () => {
    await expect503(await portalDownload(req('/api/patient-portal/lab-reports/41/download'), idParams('41')), 'patient lab report download')
  })

  it('RCM claim document view answers 503', async () => {
    await expect503(await claimDocument(req('/api/rcm/claim-documents/4'), idParams('4')), 'view claim document')
  })

  it('document download answers 503', async () => {
    await expect503(await documentDownload(req('/api/documents/9/download'), idParams('9')), 'document download')
  })

  it('insurance card upload answers 503 before storing anything', async () => {
    const form = new FormData()
    form.set('side', 'front')
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'card.png', { type: 'image/png' }))
    const res = await insuranceCardUpload(req('/api/patients/RD-0001/insurance-card', { method: 'POST', body: form }), { params: Promise.resolve({ anonId: 'RD-0001' }) })
    await expect503(res, 'insurance card upload')
  })
})
