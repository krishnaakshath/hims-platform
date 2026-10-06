import { describe, it, expect, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import * as auth from '@/lib/auth'

const UNAUTHORIZED = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

import { GET as listAuditLog } from '@/app/api/audit-log/route'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'admin' as const, name: 'Test Admin' })) }
})

describe('GET /api/audit-log', () => {
  it('returns 401 when there is no authenticated session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce(UNAUTHORIZED())
    const response = await listAuditLog(new NextRequest('http://localhost/api/audit-log'))
    expect(response.status).toBe(401)
  })

  it('returns 403 for a non-admin session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'crc', name: 'Test CRC', userId: null })
    const response = await listAuditLog(new NextRequest('http://localhost/api/audit-log'))
    expect(response.status).toBe(403)
  })

  it('returns 403 for a PI session (audit log is admin-only, not just non-CRC)', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name: 'Test PI', userId: null })
    const response = await listAuditLog(new NextRequest('http://localhost/api/audit-log'))
    expect(response.status).toBe(403)
  })

  it('returns entries ordered newest first for an admin session', async () => {
    const response = await listAuditLog(new NextRequest('http://localhost/api/audit-log'))
    const body = await response.json()
    expect(Array.isArray(body.entries)).toBe(true)
    if (body.entries.length > 1) {
      const first = new Date(body.entries[0].timestamp).getTime()
      const second = new Date(body.entries[1].timestamp).getTime()
      expect(first).toBeGreaterThanOrEqual(second)
    }
  })
})
