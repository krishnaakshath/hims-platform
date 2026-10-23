// @vitest-environment node
// Lab report release with no file storage answers 503 storage_not_configured; with the local
// driver the release succeeds and the PDF streams back through the authenticated, audited route.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const audit = vi.fn(async () => undefined)
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'admin', name: 'Test admin', userId: null })) }
})
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => audit(...(a as [])) }))
vi.mock('@/lib/queries/notifications', () => ({ notifyPatientSafely: vi.fn(async () => undefined) }))
vi.mock('@/lib/follow-ups/notifier', () => ({ notifyFollowUpSafely: vi.fn(async () => undefined) }))

const PDF = new Uint8Array([37, 80, 68, 70, 45, 49])
let storedUrl = ''
vi.mock('@/lib/queries/lab-reports', () => ({
  // Mirrors the real release: store the rendered PDF through putPrivateBlob, return the report.
  releaseLabReport: vi.fn(async () => {
    const { putPrivateBlob } = await import('@/lib/blob-store')
    const { url } = await putPrivateBlob('lab-reports/1/LR-2099-000007-v1.pdf', PDF, 'application/pdf')
    storedUrl = url
    return { ok: true, report: { id: 41, patientId: 'RD-0001', reportNumber: 'LR-2099-000007', version: 1 }, followUp: { outcome: 'none', followUpOrderId: null, dueDate: null } }
  }),
  getLabReportForDownload: vi.fn(async () => ({ id: 41, patientId: 'RD-0001', reportNumber: 'LR-2099-000007', blobUrl: storedUrl, supersededAt: null })),
}))

import { POST as release } from '@/app/api/lab-requisitions/[id]/report/route'
import { GET as download } from '@/app/api/lab-reports/[id]/download/route'

const idParams = (id: string) => ({ params: Promise.resolve({ id }) })
let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'hims-lab-'))
  audit.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }) })

describe('lab report release and storage', () => {
  it('answers 503 storage_not_configured when BLOB_DRIVER names no known driver', async () => {
    vi.stubEnv('BLOB_DRIVER', 'no-such-driver')
    const res = await release(new NextRequest('http://localhost/api/lab-requisitions/7/report', { method: 'POST' }), idParams('7'))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'File storage is not set up. Ask your administrator.', code: 'storage_not_configured' })
  })

  it('releases with the local driver and streams the PDF back, audited', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BLOB_DRIVER', '')
    vi.stubEnv('BLOB_LOCAL_DIR', dir)
    const res = await release(new NextRequest('http://localhost/api/lab-requisitions/7/report', { method: 'POST' }), idParams('7'))
    expect(res.status).toBe(201)
    expect(storedUrl).toBe('local:lab-reports/1/LR-2099-000007-v1.pdf')
    const dl = await download(new NextRequest('http://localhost/api/lab-reports/41/download'), idParams('41'))
    expect(dl.status).toBe(200)
    expect(dl.headers.get('Content-Type')).toBe('application/pdf')
    expect(Array.from(new Uint8Array(await dl.arrayBuffer()))).toEqual(Array.from(PDF))
    expect(audit).toHaveBeenCalledTimes(1)
  })
})
