// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const opened = vi.fn()
vi.mock('@/lib/nhcx/jwe', async () => {
  const actual = await vi.importActual<typeof import('@/lib/nhcx/jwe')>('@/lib/nhcx/jwe')
  return { ...actual, openHcxPayload: (...a: Parameters<typeof actual.openHcxPayload>) => { opened(); return actual.openHcxPayload(...a) } }
})
const dbTouched = vi.fn()
vi.mock('@/db/client', () => ({ getDb: () => { dbTouched(); throw new Error('DB_BLOCKED') } }))

import { handleNhcxCallback, actionFromPath, type InboundDeps } from '@/lib/nhcx/inbound'
import { NextRequest } from 'next/server'
import { GET, POST } from '@/app/api/nhcx/callback/[...action]/route'
import { makeCallbackKit } from '../helpers/nhcx-callback'

const kit = makeCallbackKit()
const FHIR = { resourceType: 'Bundle', type: 'collection', entry: [] }
const deps = (over: Partial<InboundDeps> = {}): Partial<InboundDeps> => ({ config: () => ({ state: 'configured', config: kit.cfg }), now: () => new Date(), rateLimit: async () => ({ allowed: true }), ...over })
const FIXED_BODIES = new Set(['Not found', 'NHCX is not configured', 'NHCX callbacks are not configured', 'Payload too large', 'Forbidden', 'Too many requests', 'Unauthorized', 'Invalid request', 'Unknown correlation'])

beforeEach(() => { opened.mockClear(); dbTouched.mockClear() })

describe('NHCX callback receiver (before any write)', () => {
  it('maps paths with or without v1 and refuses others', () => {
    expect(actionFromPath(['claim', 'on_submit'])).toBe('claim/on_submit')
    expect(actionFromPath(['v1', 'on_status'])).toBe('on_status')
    expect(actionFromPath(['claim', 'submit'])).toBeNull()
  })
  it('an unknown action path is a 404 before the body is read', async () => {
    const { req } = await kit.request('claim/submit', FHIR)
    const r = await handleNhcxCallback(req, 'claim/submit', deps())
    expect(r).toEqual({ http: 404, body: { error: 'Not found' } }); expect(req.bodyUsed).toBe(false)
  })
  it('an oversized body is refused before parsing', async () => {
    const { req } = await kit.request('claim/on_submit', FHIR, { httpHeaders: { 'content-length': '3000000' } })
    expect((await handleNhcxCallback(req, 'claim/on_submit', deps())).http).toBe(413); expect(opened).not.toHaveBeenCalled(); expect(req.bodyUsed).toBe(false)
  })
  it('rejects a callback whose JWT does not verify, before decrypting', async () => {
    const { req } = await kit.request('claim/on_submit', FHIR, { jwt: await kit.bearer(kit.stranger.privateKeyPem) })
    expect(await handleNhcxCallback(req, 'claim/on_submit', deps())).toEqual({ http: 401, body: { error: 'Unauthorized' } })
    expect(opened).not.toHaveBeenCalled(); expect(dbTouched).not.toHaveBeenCalled(); expect(req.bodyUsed).toBe(false)
  })
  it('503 without a signing cert or configuration; 403 for an IP outside a set allowlist; 429 for a burst', async () => {
    const a = await kit.request('claim/on_submit', FHIR)
    expect(await handleNhcxCallback(a.req, 'claim/on_submit', deps({ config: () => ({ state: 'configured', config: { ...kit.cfg, gatewaySigningCertPem: null } }) }))).toEqual({ http: 503, body: { error: 'NHCX callbacks are not configured' } })
    const b = await kit.request('claim/on_submit', FHIR)
    expect((await handleNhcxCallback(b.req, 'claim/on_submit', deps({ config: () => ({ state: 'not_configured', missing: [] }) }))).http).toBe(503)
    const c = await kit.request('claim/on_submit', FHIR)
    expect(await handleNhcxCallback(c.req, 'claim/on_submit', deps({ config: () => ({ state: 'configured', config: { ...kit.cfg, callbackIpAllowlist: ['3.109.99.210'] } }) }))).toEqual({ http: 403, body: { error: 'Forbidden' } })
    const d = await kit.request('claim/on_submit', FHIR)
    expect((await handleNhcxCallback(d.req, 'claim/on_submit', deps({ rateLimit: async () => ({ allowed: false }) }))).http).toBe(429)
    expect(opened).not.toHaveBeenCalled(); expect(dbTouched).not.toHaveBeenCalled()
  })
  it('a recipient code that is not ours is a 403 with no write', async () => {
    const { req } = await kit.request('claim/on_submit', FHIR, { headers: { recipient: 'P2@sbx' } })
    expect(await handleNhcxCallback(req, 'claim/on_submit', deps())).toEqual({ http: 403, body: { error: 'Forbidden' } }); expect(dbTouched).not.toHaveBeenCalled()
  })
  it('a stale timestamp is refused', async () => {
    const { req } = await kit.request('claim/on_submit', FHIR, { now: new Date(Date.now() - 3_600_000) })
    expect(await handleNhcxCallback(req, 'claim/on_submit', deps())).toEqual({ http: 400, body: { error: 'Invalid request' } }); expect(dbTouched).not.toHaveBeenCalled()
  })
  it('a payload sealed for someone else is refused', async () => {
    const { req } = await kit.request('claim/on_submit', FHIR)
    expect((await handleNhcxCallback(req, 'claim/on_submit', deps({ config: () => ({ state: 'configured', config: { ...kit.cfg, encryptionPrivateKeyPem: kit.stranger.privateKeyPem } }) }))).http).toBe(400)
  })
  it('error bodies are fixed strings', async () => {
    const cases = [
      handleNhcxCallback((await kit.request('x', FHIR)).req, 'claim/submit', deps()),
      handleNhcxCallback((await kit.request('x', FHIR, { jwt: 'a.b.c' })).req, 'claim/on_submit', deps()),
      handleNhcxCallback((await kit.request('x', FHIR, { headers: { recipient: 'P2@sbx' } })).req, 'claim/on_submit', deps()),
    ]
    for (const r of await Promise.all(cases)) {
      const body = r.body as { error: string }
      expect(FIXED_BODIES.has(body.error)).toBe(true)
      expect(JSON.stringify(body)).not.toMatch(/TPA1|P2@sbx|P1@sbx/)
    }
  })
  it('the route answers 405 for other methods', async () => {
    const r = await GET()
    expect(r.status).toBe(405)
    const p = await POST(new NextRequest('https://app.example/api/nhcx/callback/claim/submit', { method: 'POST', body: '{}' }), { params: Promise.resolve({ action: ['claim', 'submit'] }) })
    expect(p.status).toBe(404)
  })
})
