// SP5 Task 14: report release and staff download, with the session, queries, blob helper and
// notifiers mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { Role } from '@/lib/auth'

let role: Role = 'labs'
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => ({ role, name: 'TEST_SP5_probe', userId: 3 })),
}))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/lab-reports', () => ({ releaseLabReport: vi.fn(), getLabReportForDownload: vi.fn() }))
vi.mock('@/lib/blob-store', () => ({ streamPrivateBlob: vi.fn() }))
vi.mock('@/lib/queries/notifications', () => ({ notifyPatientSafely: vi.fn(async () => 'logged') }))
vi.mock('@/lib/follow-ups/notifier', () => ({ notifyFollowUpSafely: vi.fn(async () => undefined) }))

import { POST as release } from '@/app/api/lab-requisitions/[id]/report/route'
import { GET as download } from '@/app/api/lab-reports/[id]/download/route'
import { releaseLabReport, getLabReportForDownload } from '@/lib/queries/lab-reports'
import { streamPrivateBlob } from '@/lib/blob-store'
import { notifyPatientSafely } from '@/lib/queries/notifications'
import { notifyFollowUpSafely } from '@/lib/follow-ups/notifier'
import { logAudit } from '@/lib/audit'
import { brand } from '@/lib/brand'

const BLOB_URL = 'https://store.private.blob.vercel-storage.com/lab-reports/5/LR-2099-000007-x.pdf'
const REPORT = {
  id: 41, reportNumber: 'LR-2099-000007', requisitionId: 5, patientId: 'RD-0001', version: 2, orderIds: [8, 9], testSummary: 'HbA1c, TSH',
  blobUrl: BLOB_URL, byteSize: 1200, sha256: 'ab', releasedByName: 'TEST_SP5_probe', releasedByUserId: 3, releasedAt: new Date('2099-08-01T05:00:00Z'), supersededAt: null,
}
const callRelease = (id = '5') =>
  release(new NextRequest(`http://localhost/api/lab-requisitions/${id}/report`, { method: 'POST' }), { params: Promise.resolve({ id }) })
const callDownload = (id = '41') =>
  download(new NextRequest(`http://localhost/api/lab-reports/${id}/download`), { params: Promise.resolve({ id }) })

beforeEach(() => {
  role = 'labs'
  vi.mocked(releaseLabReport).mockReset()
  vi.mocked(getLabReportForDownload).mockReset()
  vi.mocked(streamPrivateBlob).mockReset()
  vi.mocked(notifyPatientSafely).mockClear()
  vi.mocked(notifyFollowUpSafely).mockClear()
  vi.mocked(logAudit).mockClear()
})

describe('POST /api/lab-requisitions/[id]/report', () => {
  it.each(['frontdesk', 'billing', 'pharmacy', 'crc', 'collector', 'coder'] as Role[])('%s is 403 and nothing is released', async (r) => {
    role = r
    const res = await callRelease()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(releaseLabReport).not.toHaveBeenCalled()
  })

  it.each(['abc', '0', '-1', '1.5', '99999999999'])('id %s is 400 before the query', async (id) => {
    const res = await callRelease(id)
    expect(res.status).toBe(400)
    expect(releaseLabReport).not.toHaveBeenCalled()
  })

  it('maps not_found, nothing_to_report, stale and a deadlock', async () => {
    vi.mocked(releaseLabReport).mockResolvedValueOnce({ ok: false, error: 'not_found' })
    const nf = await callRelease()
    expect(nf.status).toBe(404)
    expect(await nf.json()).toEqual({ error: 'Lab requisition not found' })
    vi.mocked(releaseLabReport).mockResolvedValueOnce({ ok: false, error: 'nothing_to_report' })
    const none = await callRelease()
    expect(none.status).toBe(409)
    expect(await none.json()).toEqual({ error: 'No verified results to report yet.' })
    vi.mocked(releaseLabReport).mockResolvedValueOnce({ ok: false, error: 'stale' })
    const stale = await callRelease()
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'Results changed while the report was being generated. Please try again.' })
    vi.mocked(releaseLabReport).mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: '40P01' }))
    expect((await callRelease()).status).toBe(409)
    expect(notifyPatientSafely).not.toHaveBeenCalled()
  })

  it('an unexpected error is a generic 500 that echoes nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(releaseLabReport).mockRejectedValueOnce(new Error(`put failed ${BLOB_URL}`))
    const res = await callRelease()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('blob')
    expect(spy.mock.calls.flat().map(String).join(' ')).not.toContain(BLOB_URL)
    spy.mockRestore()
  })

  it('notifies report-ready and the planned follow-up after a 201', async () => {
    vi.mocked(releaseLabReport).mockResolvedValue({ ok: true, report: REPORT, followUp: { outcome: 'created', followUpOrderId: 12, dueDate: '2099-08-15' } })
    const res = await callRelease()
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toEqual({ report: { id: 41, reportNumber: 'LR-2099-000007', version: 2 }, followUp: { outcome: 'created', followUpOrderId: 12, dueDate: '2099-08-15' } })
    expect(JSON.stringify(body)).not.toContain('blob')
    expect(releaseLabReport).toHaveBeenCalledWith(5, expect.objectContaining({ role: 'labs', userId: 3 }))
    expect(notifyPatientSafely).toHaveBeenCalledWith(expect.objectContaining({ role: 'labs' }), {
      patientId: 'RD-0001', templateKey: 'lab_report_ready', vars: { hospitalName: brand.name },
      related: { type: 'lab_report', id: 41 }, dedupeKey: 'lab_report_ready:report=41',
    })
    expect(notifyFollowUpSafely).toHaveBeenCalledWith(expect.objectContaining({ role: 'labs' }), {
      kind: 'planned', followUpOrderId: 12, patientId: 'RD-0001', dueDate: '2099-08-15', appointmentStartsAt: null,
    })
    // Notices run only after the release transaction has resolved.
    expect(vi.mocked(releaseLabReport).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(notifyPatientSafely).mock.invocationCallOrder[0])
  })

  it.each(['linked', 'pending', 'failed', 'not_requested', 'already_resolved'] as const)('no follow-up notice when the outcome is %s', async (outcome) => {
    vi.mocked(releaseLabReport).mockResolvedValue({ ok: true, report: REPORT, followUp: { outcome, followUpOrderId: outcome === 'linked' ? 4 : null, dueDate: null } })
    expect((await callRelease()).status).toBe(201)
    expect(notifyPatientSafely).toHaveBeenCalledTimes(1)
    expect(notifyFollowUpSafely).not.toHaveBeenCalled()
  })

  it('a failed notice still returns 201', async () => {
    vi.mocked(notifyPatientSafely).mockResolvedValueOnce('error')
    vi.mocked(releaseLabReport).mockResolvedValue({ ok: true, report: REPORT, followUp: { outcome: 'not_requested', followUpOrderId: null, dueDate: null } })
    expect((await callRelease()).status).toBe(201)
  })

  it.each(['admin', 'pi', 'labs'] as Role[])('%s may release', async (r) => {
    role = r
    vi.mocked(releaseLabReport).mockResolvedValue({ ok: true, report: REPORT, followUp: { outcome: 'not_requested', followUpOrderId: null, dueDate: null } })
    expect((await callRelease()).status).toBe(201)
  })
})

describe('GET /api/lab-reports/[id]/download', () => {
  it.each(['frontdesk', 'billing', 'pharmacy', 'collector', 'coder'] as Role[])('%s cannot download (403)', async (r) => {
    role = r
    const res = await callDownload()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(getLabReportForDownload).not.toHaveBeenCalled()
  })

  it('an unknown or malformed id is 404 Report not found', async () => {
    vi.mocked(getLabReportForDownload).mockResolvedValue(null)
    const res = await callDownload('41')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Report not found' })
    const bad = await callDownload('x')
    expect(bad.status).toBe(404)
    expect(getLabReportForDownload).toHaveBeenCalledTimes(1)
  })

  it('download streams through the helper and audits after the blob is found', async () => {
    vi.mocked(getLabReportForDownload).mockResolvedValue({ id: 41, patientId: 'RD-0001', reportNumber: 'LR-2099-000007', blobUrl: BLOB_URL, supersededAt: null })
    vi.mocked(streamPrivateBlob).mockResolvedValueOnce(null)
    const missing = await callDownload()
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'Stored file is missing' })
    expect(logAudit).not.toHaveBeenCalled()

    vi.mocked(streamPrivateBlob).mockResolvedValueOnce(new NextResponse('%PDF-', { headers: { 'Content-Type': 'application/pdf' } }))
    const ok = await callDownload()
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('%PDF-')
    expect(streamPrivateBlob).toHaveBeenLastCalledWith(BLOB_URL, { filename: 'LR-2099-000007.pdf', disposition: 'inline' })
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ role: 'labs' }), 'downloaded lab report', 'RD-0001', 'report=41')
  })

  it.each(['admin', 'pi', 'crc', 'labs'] as Role[])('%s may download, a superseded version too', async (r) => {
    role = r
    vi.mocked(getLabReportForDownload).mockResolvedValue({ id: 41, patientId: 'RD-0001', reportNumber: 'LR-2099-000007', blobUrl: BLOB_URL, supersededAt: new Date() })
    vi.mocked(streamPrivateBlob).mockResolvedValue(new NextResponse('%PDF-'))
    expect((await callDownload()).status).toBe(200)
  })
})
