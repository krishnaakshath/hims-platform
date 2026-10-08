import { describe, it, expect } from 'vitest'
import { INVALID_ID_MESSAGE, INVALID_JSON_MESSAGE, invalidIdResponse, parseId, readJsonBody } from '@/lib/http'

function req(body?: string) {
  return new Request('http://localhost/x', { method: 'POST', body })
}

describe('readJsonBody', () => {
  it('returns the parsed body', async () => {
    const r = await readJsonBody(req('{"a":1}'))
    expect(r).toEqual({ ok: true, body: { a: 1 } })
  })

  it.each([['{not json'], ['x'], [''], ['   ']])('answers %j with a 400 carrying the fixed message (never the input)', async (raw) => {
    const r = await readJsonBody(req(raw))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.response.status).toBe(400)
    const body = await r.response.json()
    expect(body).toEqual({ error: INVALID_JSON_MESSAGE })
    expect(JSON.stringify(body)).not.toContain('not json')
  })

  it('answers a request with no body at all with a 400', async () => {
    const r = await readJsonBody(new Request('http://localhost/x', { method: 'POST' }))
    expect(r.ok).toBe(false)
  })

  it('maps an empty body to `emptyAs` when the route allows one', async () => {
    expect(await readJsonBody(req(''), { emptyAs: {} })).toEqual({ ok: true, body: {} })
    expect(await readJsonBody(new Request('http://localhost/x', { method: 'POST' }), { emptyAs: {} })).toEqual({ ok: true, body: {} })
    const bad = await readJsonBody(req('{oops'), { emptyAs: {} })
    expect(bad.ok).toBe(false)
  })
})

describe('parseId', () => {
  it('accepts plain positive int4 digits', () => {
    expect(parseId('1')).toBe(1)
    expect(parseId('42')).toBe(42)
    expect(parseId('2147483647')).toBe(2_147_483_647)
  })

  it.each([
    ['0'], ['-1'], ['abc'], ['NaN'], [''], ['1.5'], ['1e3'], [' 1'], ['1 '], ['+1'], ['0x10'],
    ['2147483648'], ['99999999999'], ['Infinity'],
  ])('rejects %j', (raw) => {
    expect(parseId(raw)).toBeNull()
  })

  it('rejects null/undefined', () => {
    expect(parseId(null)).toBeNull()
    expect(parseId(undefined)).toBeNull()
  })

  it('invalidIdResponse is a fixed 400', async () => {
    const res = invalidIdResponse()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: INVALID_ID_MESSAGE })
  })
})
