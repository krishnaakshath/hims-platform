import { describe, it, expect, vi, afterEach } from 'vitest'
import { CLIENT_ERROR_MESSAGES, fetchJson, messageForStatus, readError, sendJson } from '@/lib/client-fetch'

function jsonResponse(status: number, body: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => vi.unstubAllGlobals())

describe('messageForStatus', () => {
  it('has a fixed human message per status class', () => {
    expect(messageForStatus(400)).toBe(CLIENT_ERROR_MESSAGES.badRequest)
    expect(messageForStatus(401)).toBe(CLIENT_ERROR_MESSAGES.unauthorized)
    expect(messageForStatus(403)).toBe(CLIENT_ERROR_MESSAGES.forbidden)
    expect(messageForStatus(404)).toBe(CLIENT_ERROR_MESSAGES.notFound)
    expect(messageForStatus(409)).toBe(CLIENT_ERROR_MESSAGES.conflict)
    expect(messageForStatus(429)).toBe(CLIENT_ERROR_MESSAGES.tooMany)
    expect(messageForStatus(500)).toBe(CLIENT_ERROR_MESSAGES.server)
    expect(messageForStatus(503)).toBe(CLIENT_ERROR_MESSAGES.server)
    expect(messageForStatus(0)).toBe(CLIENT_ERROR_MESSAGES.network)
    expect(CLIENT_ERROR_MESSAGES.conflict).toMatch(/try again/i)
  })
})

describe('readError', () => {
  it('passes on the route\'s own short message for 400/404/409/422', async () => {
    expect(await readError(jsonResponse(400, { error: 'Choose a doctor.' }))).toBe('Choose a doctor.')
    expect(await readError(jsonResponse(404, { error: 'Patient not found' }))).toBe('Patient not found')
    expect(await readError(jsonResponse(409, { error: 'Already booked' }))).toBe('Already booked')
  })

  it('falls back to the fixed message when the body has no usable error', async () => {
    expect(await readError(jsonResponse(400, {}))).toBe(CLIENT_ERROR_MESSAGES.badRequest)
    expect(await readError(new Response('<html>oops</html>', { status: 404 }))).toBe(CLIENT_ERROR_MESSAGES.notFound)
    expect(await readError(jsonResponse(409, { error: 'x'.repeat(500) }))).toBe(CLIENT_ERROR_MESSAGES.conflict)
  })

  it('never shows server text for 401/403/429/5xx', async () => {
    expect(await readError(jsonResponse(401, { error: 'jwt expired at …' }))).toBe(CLIENT_ERROR_MESSAGES.unauthorized)
    expect(await readError(jsonResponse(403, { error: 'Forbidden: role crc' }))).toBe(CLIENT_ERROR_MESSAGES.forbidden)
    expect(await readError(jsonResponse(429, { error: 'bucket 7' }))).toBe(CLIENT_ERROR_MESSAGES.tooMany)
    expect(await readError(jsonResponse(500, { error: 'relation "patients" does not exist' }))).toBe(CLIENT_ERROR_MESSAGES.server)
  })
})

describe('passThrough option', () => {
  it('shows the authored text for an opted-in status only', async () => {
    expect(await readError(jsonResponse(401, { error: 'Invalid code' }), { passThrough: [401] })).toBe('Invalid code')
    expect(await readError(jsonResponse(401, { error: 'Invalid code' }))).toBe(CLIENT_ERROR_MESSAGES.unauthorized)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'Invalid code' })))
    expect(await sendJson('/api/x', 'POST', {}, { passThrough: [401] })).toMatchObject({ ok: false, status: 401, error: 'Invalid code' })
  })
})

describe('sendJson / fetchJson', () => {
  it('sends JSON and returns the parsed data on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { id: 7 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await sendJson<{ id: number }>('/api/x', 'POST', { a: 1 })
    expect(r).toEqual({ ok: true, status: 201, data: { id: 7 } })
    expect(fetchMock).toHaveBeenCalledWith('/api/x', expect.objectContaining({
      method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' },
    }))
  })

  it('omits the body for a body-less call and tolerates an empty response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await sendJson('/api/x', 'DELETE')
    expect(r).toEqual({ ok: true, status: 204, data: null })
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined()
  })

  it('returns the readable error on a failed response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom stack' })))
    expect(await sendJson('/api/x', 'PATCH', {})).toEqual({ ok: false, status: 500, error: CLIENT_ERROR_MESSAGES.server, body: { error: 'boom stack' } })
  })

  it('returns the network message when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    expect(await fetchJson('/api/x')).toEqual({ ok: false, status: 0, error: CLIENT_ERROR_MESSAGES.network })
  })

  it('fetchJson passes a FormData body through untouched', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const fd = new FormData()
    await fetchJson('/api/upload', { method: 'POST', body: fd })
    expect(fetchMock.mock.calls[0][1].body).toBe(fd)
  })
})
