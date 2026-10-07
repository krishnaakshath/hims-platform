// Byte-capped request body reader (extracted from the tariff import route, SP6 Task 6).
import { describe, it, expect } from 'vitest'
import { readCappedBody } from '@/lib/http/read-capped-body'

type Init = RequestInit & { duplex?: 'half' }
const req = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('http://localhost/x', { method: 'POST', headers, body, duplex: 'half' } as Init)

describe('readCappedBody', () => {
  it('returns the bytes when the body fits', async () => {
    const r = await readCappedBody(req('0123456789'), 10)
    expect(r.ok).toBe(true)
    if (r.ok) expect(new TextDecoder().decode(r.bytes)).toBe('0123456789')
  })

  it('returns empty bytes for no body', async () => {
    const r = await readCappedBody(new Request('http://localhost/x', { method: 'POST' }), 10)
    expect(r).toEqual({ ok: true, bytes: new Uint8Array(0) })
  })

  it('stops at the cap and rejects a lying content-length', async () => {
    expect(await readCappedBody(req('01234567890'), 10)).toEqual({ ok: false, reason: 'too_large' })
    expect(await readCappedBody(req('01', { 'content-length': 'abc' }), 10)).toEqual({ ok: false, reason: 'bad_length' })
  })

  it('refuses a declared length over the cap without reading the body', async () => {
    let pulled = 0
    const stream = new ReadableStream({ pull() { pulled++ } }, { highWaterMark: 0 })
    expect(await readCappedBody(req(stream, { 'content-length': '11' }), 10)).toEqual({ ok: false, reason: 'too_large' })
    expect(pulled).toBe(0)
  })

  it('counts streamed bytes when no length is declared and cancels the stream at the cap', async () => {
    let pulled = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { pulled++; if (pulled > 100) c.close(); else c.enqueue(new Uint8Array(4)) },
      cancel() { cancelled = true },
    })
    expect(await readCappedBody(req(stream), 10)).toEqual({ ok: false, reason: 'too_large' })
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(10)
  })
})
