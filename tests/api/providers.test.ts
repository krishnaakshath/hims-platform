import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import * as auth from '@/lib/auth'
import { getDb } from '@/db/client'
import { providers } from '@/db/schema'
import { PUT as updateProvider } from '@/app/api/providers/[id]/route'
import { listAllProviders } from '@/lib/queries/providers'

const UNAUTHORIZED = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'admin' as const, name: 'Test Admin' })) }
})

// Every write test below renames a real seeded provider -- snapshot and
// restore it so a test run doesn't leave a renamed provider showing up
// throughout the app (appointments, "My Patients" matching, etc).
let testProviderId: number
let originalName: string
beforeAll(async () => {
  const [row] = await getDb().select({ id: providers.id, name: providers.name }).from(providers).limit(1)
  if (!row) throw new Error('No seeded providers found -- run npm run db:seed')
  testProviderId = row.id
  originalName = row.name
})
afterAll(async () => {
  await getDb().update(providers).set({ name: originalName }).where(eq(providers.id, testProviderId))
})

function req(name: unknown) {
  return new NextRequest(`http://localhost/api/providers/${testProviderId}`, { method: 'PUT', body: JSON.stringify({ name }) })
}

describe('PUT /api/providers/[id]', () => {
  it('returns 401 when there is no authenticated session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce(UNAUTHORIZED())
    const res = await updateProvider(req('Dr. Test'), { params: Promise.resolve({ id: String(testProviderId) }) })
    expect(res.status).toBe(401)
  })

  it('rejects a non-admin session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'crc', name: 'Test CRC', userId: null })
    const res = await updateProvider(req('Dr. Test'), { params: Promise.resolve({ id: String(testProviderId) }) })
    expect(res.status).toBe(403)
  })

  it('rejects an empty name', async () => {
    const res = await updateProvider(req(''), { params: Promise.resolve({ id: String(testProviderId) }) })
    expect(res.status).toBe(400)
  })

  it('rejects an unexpected extra field (.strict() enforcement)', async () => {
    const bad = new NextRequest(`http://localhost/api/providers/${testProviderId}`, { method: 'PUT', body: JSON.stringify({ name: 'Dr. Test', specialty: 'x' }) })
    const res = await updateProvider(bad, { params: Promise.resolve({ id: String(testProviderId) }) })
    expect(res.status).toBe(400)
  })

  it('returns 404 for a nonexistent provider id', async () => {
    const bad = new NextRequest('http://localhost/api/providers/999999', { method: 'PUT', body: JSON.stringify({ name: 'Dr. Test' }) })
    const res = await updateProvider(bad, { params: Promise.resolve({ id: '999999' }) })
    expect(res.status).toBe(404)
  })

  it('renames a real provider and it is reflected in listAllProviders', async () => {
    const res = await updateProvider(req('Dr. Renamed Test'), { params: Promise.resolve({ id: String(testProviderId) }) })
    expect(res.status).toBe(200)
    const all = await listAllProviders()
    expect(all.find((p) => p.id === testProviderId)?.name).toBe('Dr. Renamed Test')
  })
})
