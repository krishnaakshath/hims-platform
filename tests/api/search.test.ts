import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/db/client'
import type { Role } from '@/lib/auth'
import { GET } from '@/app/api/search/route'

let sessionRole: Role = 'admin'
let signedIn = true
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () =>
    signedIn ? { role: sessionRole, name: 'Test User', userId: null } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  ),
}))
// Audit rows are append-only compliance records; never write or delete them here.
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/db/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/client')>()
  return { ...actual, getDb: vi.fn(actual.getDb) }
})

afterEach(() => { sessionRole = 'admin'; signedIn = true; vi.mocked(getDb).mockClear() })

const search = (q: string) => GET(new NextRequest(`http://localhost/api/search?q=${encodeURIComponent(q)}`))

describe('GET /api/search', () => {
  it('401s without a session', async () => {
    signedIn = false
    expect((await search('RD-0001')).status).toBe(401)
  })

  for (const role of ['pharmacy', 'billing', 'labs'] as const) {
    it(`403s ${role} without touching the database`, async () => {
      sessionRole = role
      const res = await search('RD-0001')
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
      expect(getDb).not.toHaveBeenCalled()
    })
  }

  it('gives frontdesk patients only, with no clinical fields', async () => {
    sessionRole = 'frontdesk'
    const res = await search('RD-0001')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.patients.length).toBeGreaterThan(0)
    expect(body.trials).toEqual([])
    expect(body.formTemplates).toEqual([])
    for (const p of body.patients) {
      expect(Object.keys(p).sort()).toEqual(['detail', 'href', 'id', 'label'])
      expect(p.detail.startsWith(p.id)).toBe(true)
      expect(p.href).toBe(`/patients/${p.id}`)
    }
  })

  for (const role of ['admin', 'crc', 'pi'] as const) {
    it(`returns patients, trials and form templates for ${role}`, async () => {
      sessionRole = role
      const patients = await (await search('RD-0001')).json()
      expect(patients.patients.some((p: { id: string }) => p.id === 'RD-0001')).toBe(true)
      const trials = await (await search('depressive')).json()
      expect(trials.trials.length).toBeGreaterThan(0)
      expect(trials.trials[0].href).toMatch(/^\/trials\//)
    })
  }
})
