import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { appSettings, auditLog } from '@/db/schema'
import { getAppSettings } from '@/lib/queries/settings'
import { PUT } from '@/app/api/settings/queue-display-pin/route'
import { POST as generate } from '@/app/api/settings/queue-display-pin/generate/route'
import { GET as getQueueDisplay } from '@/app/api/queue-display/route'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'admin' as const, name: 'Test Admin' })) }))

// This is the single shared app_settings row the real Settings page (and the
// real lobby display) reads -- the "accepts a valid PIN" test below writes a
// real PIN to it. Snapshot and restore it, same as tests/api/settings.test.ts
// does for practiceName/EHR credentials, so a test run doesn't silently
// change the actual staff-configured lobby PIN for whoever opens the app
// next, and doesn't leave the shared row in a different state than it found
// it (this is a single shared Neon DB used by every branch/worktree).
let originalSettings: Awaited<ReturnType<typeof getAppSettings>>
beforeAll(async () => {
  originalSettings = await getAppSettings()
})
afterAll(async () => {
  await getDb().update(appSettings).set({ queueDisplayPin: originalSettings.queueDisplayPin }).where(eq(appSettings.id, originalSettings.id))
})

describe('PUT /api/settings/queue-display-pin', () => {
  it('returns 401 when there is no authenticated session', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSession).mockResolvedValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ pin: '1234' }) })
    const res = await PUT(req as never)
    expect(res.status).toBe(401)
  })

  it('rejects a non-admin session', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'frontdesk', name: 'Test Frontdesk', userId: null })
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ pin: '1234' }) })
    const res = await PUT(req as never)
    expect(res.status).toBe(403)
  })

  it('rejects an unknown field (mass-assignment guard)', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ pin: '1234', notAField: true }) })
    const res = await PUT(req as never)
    expect(res.status).toBe(400)
  })

  it('rejects a PIN shorter than 6 characters', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ pin: '12345' }) })
    const res = await PUT(req as never)
    expect(res.status).toBe(400)
  })

  it('rejects a PIN that is only whitespace once trimmed (bundled Minor #3)', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ pin: '   ' }) })
    const res = await PUT(req as never)
    expect(res.status).toBe(400)
  })

  it('trims a PIN with leading/trailing whitespace before storing it (bundled Minor #3)', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ pin: '  482100  ' }) })
    const res = await PUT(req as never)
    expect(res.status).toBe(200)
    const stored = await getAppSettings()
    expect(stored.queueDisplayPin).toBe('482100')
  })

  it('accepts a valid PIN from an admin session', async () => {
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ pin: '482100' }) })
    const res = await PUT(req as never)
    expect(res.status).toBe(200)
  })
})

// WS6 T10
describe('POST /api/settings/queue-display-pin/generate', () => {
  const post = (body: unknown) => new Request('http://localhost/api/settings/queue-display-pin/generate', { method: 'POST', body: JSON.stringify(body) })

  it('returns a 6-digit PIN once, which then unlocks the display API', async () => {
    const res = await generate(post({}) as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body)).toEqual(['pin'])
    expect(body.pin).toMatch(/^\d{6}$/)
    expect((await getAppSettings()).queueDisplayPin).toBe(body.pin)

    const headers = { 'x-queue-display-pin': body.pin, 'x-forwarded-for': `198.51.100.90-${Date.now()}` }
    const display = await getQueueDisplay(new Request('http://localhost/api/queue-display', { headers }) as never)
    expect(display.status).toBe(200)

    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, 'Test Admin'), eq(auditLog.action, 'generated queue display PIN')))
    expect(audits.length).toBeGreaterThan(0)
    for (const a of audits) expect(`${a.action} ${a.details ?? ''}`).not.toContain(body.pin)
    await getDb().delete(auditLog).where(and(eq(auditLog.userName, 'Test Admin'), eq(auditLog.action, 'generated queue display PIN')))
  })

  it('refuses a non-admin with 403', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'frontdesk', name: 'Test Frontdesk', userId: null })
    const res = await generate(post({}) as never)
    expect(res.status).toBe(403)
  })

  it('rejects any body field', async () => {
    const res = await generate(post({ pin: '123456' }) as never)
    expect(res.status).toBe(400)
  })
})
