// SP5 Task 15: the patient's own lab report download. Another patient's or a superseded report
// is a 404 (never a 403, which would confirm it exists); nothing is streamed or audited.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

let sessionPatient: string | null = 'RD-0001'
vi.mock('@/lib/patient-session', () => ({
  requirePatientSession: vi.fn(async () => (sessionPatient ? { patientId: sessionPatient } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))),
}))
vi.mock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/lab-reports', () => ({ getLabReportForDownload: vi.fn() }))
vi.mock('@/lib/blob-store', () => ({ streamPrivateBlob: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => { throw new Error('staff session must not be used') }) }))

import { GET } from '@/app/api/patient-portal/lab-reports/[id]/download/route'
import { getLabReportForDownload } from '@/lib/queries/lab-reports'
import { streamPrivateBlob } from '@/lib/blob-store'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'

const BLOB_URL = 'https://store.private.blob.vercel-storage.com/lab-reports/5/x.pdf'
const call = (id = '41') => GET(new NextRequest(`http://localhost/api/patient-portal/lab-reports/${id}/download`), { params: Promise.resolve({ id }) })
const row = (over: Partial<{ patientId: string; supersededAt: Date | null }> = {}) => ({ id: 41, patientId: 'RD-0001', reportNumber: 'LR-2099-000007', blobUrl: BLOB_URL, supersededAt: null, ...over })

beforeEach(() => {
  sessionPatient = 'RD-0001'
  vi.mocked(getLabReportForDownload).mockReset()
  vi.mocked(streamPrivateBlob).mockReset()
  vi.mocked(logPatientPortalAction).mockClear()
})

describe('GET /api/patient-portal/lab-reports/[id]/download', () => {
  it('no patient session -> 401 from requirePatientSession', async () => {
    sessionPatient = null
    const res = await call()
    expect(res.status).toBe(401)
    expect(getLabReportForDownload).not.toHaveBeenCalled()
  })

  it('another patient\'s report is 404 and nothing is streamed or audited', async () => {
    vi.mocked(getLabReportForDownload).mockResolvedValue(row({ patientId: 'RD-0002' }))
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Report not found' })
    expect(streamPrivateBlob).not.toHaveBeenCalled()
    expect(logPatientPortalAction).not.toHaveBeenCalled()
  })

  it('a superseded report is 404', async () => {
    vi.mocked(getLabReportForDownload).mockResolvedValue(row({ supersededAt: new Date() }))
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Report not found' })
    expect(streamPrivateBlob).not.toHaveBeenCalled()
  })

  it('an unknown or malformed id is 404', async () => {
    vi.mocked(getLabReportForDownload).mockResolvedValue(null)
    expect((await call('41')).status).toBe(404)
    expect((await call('abc')).status).toBe(404)
    expect(getLabReportForDownload).toHaveBeenCalledTimes(1)
  })

  it('a missing stored file is 404 and not audited', async () => {
    vi.mocked(getLabReportForDownload).mockResolvedValue(row())
    vi.mocked(streamPrivateBlob).mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(404)
    expect(logPatientPortalAction).not.toHaveBeenCalled()
  })

  it('streams as an attachment and audits the download', async () => {
    vi.mocked(getLabReportForDownload).mockResolvedValue(row())
    vi.mocked(streamPrivateBlob).mockResolvedValue(new NextResponse('%PDF-', { headers: { 'Content-Disposition': 'attachment; filename="LR-2099-000007.pdf"' } }))
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="LR-2099-000007.pdf"')
    expect(streamPrivateBlob).toHaveBeenCalledWith(BLOB_URL, { filename: 'LR-2099-000007.pdf', disposition: 'attachment' })
    expect(logPatientPortalAction).toHaveBeenCalledWith('downloaded lab report via patient portal', 'RD-0001', 'report=41')
  })
})
