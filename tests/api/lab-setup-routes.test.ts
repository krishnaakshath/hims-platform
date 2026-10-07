import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

let role = 'admin'
let signedIn = true
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => (signedIn ? { role, name: 'Probe Admin', userId: 1 } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))),
}))
vi.mock('@/lib/queries/lab-setup', () => ({
  addServiceAreaPins: vi.fn(),
  setServiceAreaPinActive: vi.fn(),
  createCollectionWindow: vi.fn(),
  updateCollectionWindow: vi.fn(),
  updateLabTestSetup: vi.fn(),
}))

import { POST as postPins } from '@/app/api/settings/lab-service-area/route'
import { PATCH as patchPin } from '@/app/api/settings/lab-service-area/[id]/route'
import { POST as postWindow } from '@/app/api/settings/home-collection-windows/route'
import { PATCH as patchWindow } from '@/app/api/settings/home-collection-windows/[id]/route'
import { PATCH as patchLabTest } from '@/app/api/lab-tests/[id]/route'
import {
  addServiceAreaPins, createCollectionWindow, setServiceAreaPinActive, updateCollectionWindow, updateLabTestSetup,
} from '@/lib/queries/lab-setup'

const send = (method: 'POST' | 'PATCH', path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, { method, body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const WINDOW = { id: 4, label: 'Early', startTime: '05:00', endTime: '06:00', capacity: 3, isActive: true, sortOrder: 0 }
const TEST_ROW = { id: 9, name: 'CBC', code: 'CBC', category: 'lab', sampleType: 'blood', container: 'edta_lavender', serviceId: 3, serviceCode: 'LAB_CBC', serviceName: 'CBC' }

const ALL_CALLS = [
  () => postPins(send('POST', '/api/settings/lab-service-area', '{not json')),
  () => patchPin(send('PATCH', '/api/settings/lab-service-area/1', '{not json'), ctx('1')),
  () => postWindow(send('POST', '/api/settings/home-collection-windows', '{not json')),
  () => patchWindow(send('PATCH', '/api/settings/home-collection-windows/1', '{not json'), ctx('1')),
  () => patchLabTest(send('PATCH', '/api/lab-tests/1', '{not json'), ctx('1')),
]
const QUERIES = [addServiceAreaPins, setServiceAreaPinActive, createCollectionWindow, updateCollectionWindow, updateLabTestSetup]

beforeEach(() => {
  role = 'admin'
  signedIn = true
  vi.mocked(addServiceAreaPins).mockReset().mockResolvedValue({ added: 1, reactivated: 0, unchanged: 0 })
  vi.mocked(setServiceAreaPinActive).mockReset().mockResolvedValue({ id: 1, pinCode: '560001', areaLabel: null, isActive: false } as never)
  vi.mocked(createCollectionWindow).mockReset().mockResolvedValue({ ok: true, window: WINDOW as never })
  vi.mocked(updateCollectionWindow).mockReset().mockResolvedValue({ ok: true, window: WINDOW as never })
  vi.mocked(updateLabTestSetup).mockReset().mockResolvedValue({ ok: true, test: TEST_ROW as never })
})
afterEach(() => vi.restoreAllMocks())

describe('role gate (inline, before parse)', () => {
  it.each(['pi', 'labs', 'frontdesk', 'crc', 'billing', 'pharmacy', 'collector'] as const)('%s gets 403 before parsing on every lab-setup route', async (r) => {
    role = r
    for (const call of ALL_CALLS) {
      const res = await call()
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    for (const q of QUERIES) expect(q).not.toHaveBeenCalled()
  })

  it('401s without a session', async () => {
    signedIn = false
    for (const call of ALL_CALLS) expect((await call()).status).toBe(401)
  })

  it('400s non-JSON for admin, never a 500', async () => {
    for (const call of ALL_CALLS) {
      const res = await call()
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid JSON' })
    }
  })
})

describe('POST /api/settings/lab-service-area', () => {
  it('400s a PIN list with invalid entries and names them', async () => {
    const res = await postPins(send('POST', '/api/settings/lab-service-area', { pins: '560001, 12345' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Some PIN codes are not valid', invalid: ['12345'] })
    expect(addServiceAreaPins).not.toHaveBeenCalled()
  })

  it('400s an empty list', async () => {
    const res = await postPins(send('POST', '/api/settings/lab-service-area', { pins: ' , ' }))
    expect(res.status).toBe(400)
    expect(addServiceAreaPins).not.toHaveBeenCalled()
  })

  it('400s an unknown key without echoing it', async () => {
    const res = await postPins(send('POST', '/api/settings/lab-service-area', { pins: '560001', evil: '<script>' }))
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain('evil')
  })

  it('adds the parsed, de-duplicated PINs and returns the counts', async () => {
    const res = await postPins(send('POST', '/api/settings/lab-service-area', { pins: '560002\n560001;560001', areaLabel: ' North ' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ added: 1, reactivated: 0, unchanged: 0 })
    expect(addServiceAreaPins).toHaveBeenCalledWith(['560001', '560002'], 'North', expect.objectContaining({ role: 'admin' }))
  })

  it('409s a deadlock and 500s anything else without the message', async () => {
    vi.mocked(addServiceAreaPins).mockRejectedValueOnce(Object.assign(new Error('x'), { code: '40P01' }))
    expect((await postPins(send('POST', '/api/settings/lab-service-area', { pins: '560001' }))).status).toBe(409)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(addServiceAreaPins).mockRejectedValueOnce(new Error('secret 560001'))
    const res = await postPins(send('POST', '/api/settings/lab-service-area', { pins: '560001' }))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
    expect(err.mock.calls.flat().join(' ')).not.toContain('secret')
  })
})

describe('PATCH /api/settings/lab-service-area/[id]', () => {
  it('404s an unknown PIN and 400s a bad id', async () => {
    vi.mocked(setServiceAreaPinActive).mockResolvedValueOnce(null)
    expect((await patchPin(send('PATCH', '/api/settings/lab-service-area/5', { isActive: false }), ctx('5'))).status).toBe(404)
    expect((await patchPin(send('PATCH', '/api/settings/lab-service-area/x', { isActive: false }), ctx('x'))).status).toBe(400)
  })
  it('deactivates', async () => {
    const res = await patchPin(send('PATCH', '/api/settings/lab-service-area/1', { isActive: false }), ctx('1'))
    expect(res.status).toBe(200)
    expect(setServiceAreaPinActive).toHaveBeenCalledWith(1, false, expect.anything())
  })
})

describe('collection windows', () => {
  it('creates a window (201) and 409s an overlap', async () => {
    const body = { label: 'Early', startTime: '05:00', endTime: '06:00', capacity: 3 }
    const res = await postWindow(send('POST', '/api/settings/home-collection-windows', body))
    expect(res.status).toBe(201)
    vi.mocked(createCollectionWindow).mockResolvedValueOnce({ ok: false, error: 'overlap' })
    const clash = await postWindow(send('POST', '/api/settings/home-collection-windows', body))
    expect(clash.status).toBe(409)
    expect(await clash.json()).toEqual({ error: 'This window overlaps another active window' })
  })

  it('400s an end before the start', async () => {
    const res = await postWindow(send('POST', '/api/settings/home-collection-windows', { label: 'X', startTime: '06:00', endTime: '05:00', capacity: 3 }))
    expect(res.status).toBe(400)
    expect(createCollectionWindow).not.toHaveBeenCalled()
  })

  it('PATCH maps not_found, overlap and invalid_times', async () => {
    const call = () => patchWindow(send('PATCH', '/api/settings/home-collection-windows/4', { isActive: true }), ctx('4'))
    vi.mocked(updateCollectionWindow).mockResolvedValueOnce({ ok: false, error: 'not_found' })
    expect((await call()).status).toBe(404)
    vi.mocked(updateCollectionWindow).mockResolvedValueOnce({ ok: false, error: 'overlap' })
    const clash = await call()
    expect(clash.status).toBe(409)
    expect(await clash.json()).toEqual({ error: 'This window overlaps another active window' })
    vi.mocked(updateCollectionWindow).mockResolvedValueOnce({ ok: false, error: 'invalid_times' })
    expect((await call()).status).toBe(400)
    expect((await call()).status).toBe(200)
  })

  it('PATCH 400s an empty patch', async () => {
    expect((await patchWindow(send('PATCH', '/api/settings/home-collection-windows/4', {}), ctx('4'))).status).toBe(400)
  })
})

describe('PATCH /api/lab-tests/[id]', () => {
  it('maps the setup errors', async () => {
    const call = () => patchLabTest(send('PATCH', '/api/lab-tests/9', { serviceId: 3 }), ctx('9'))
    vi.mocked(updateLabTestSetup).mockResolvedValueOnce({ ok: false, error: 'not_found' })
    expect((await call()).status).toBe(404)
    vi.mocked(updateLabTestSetup).mockResolvedValueOnce({ ok: false, error: 'service_not_found' })
    expect((await call()).status).toBe(400)
    vi.mocked(updateLabTestSetup).mockResolvedValueOnce({ ok: false, error: 'service_not_investigation' })
    expect((await call()).status).toBe(400)
    const ok = await call()
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ test: TEST_ROW })
  })

  it('400s an unknown sample type', async () => {
    expect((await patchLabTest(send('PATCH', '/api/lab-tests/9', { sampleType: 'saliva' }), ctx('9'))).status).toBe(400)
    expect(updateLabTestSetup).not.toHaveBeenCalled()
  })
})
