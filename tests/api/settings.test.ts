import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import * as auth from '@/lib/auth'
import { getDb } from '@/db/client'
import { appSettings } from '@/db/schema'
import { PUT as updatePracticeInfo } from '@/app/api/settings/practice-info/route'
import { getSettingsSummary, getAppSettings } from '@/lib/queries/settings'

const UNAUTHORIZED = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'admin' as const, name: 'Test Admin' })) }
})

// This is the single shared app_settings row the real Settings page reads --
// every write test below mutates it for real. Snapshot and restore it so a
// test run doesn't leave "IPMG Test" on screen for whoever opens the app next.
let originalSettings: Awaited<ReturnType<typeof getAppSettings>>
beforeAll(async () => {
  originalSettings = await getAppSettings()
})
afterAll(async () => {
  await getDb().update(appSettings).set({
    practiceName: originalSettings.practiceName,
    practiceSite: originalSettings.practiceSite,
    practiceTimezone: originalSettings.practiceTimezone,
  }).where(eq(appSettings.id, originalSettings.id))
})

function req(url: string, body: unknown) {
  return new NextRequest(url, { method: 'PUT', body: JSON.stringify(body) })
}

describe('PUT /api/settings/practice-info', () => {
  it('returns 401 when there is no authenticated session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce(UNAUTHORIZED())
    const res = await updatePracticeInfo(req('http://localhost/api/settings/practice-info', { practiceName: 'x', practiceSite: 'y', practiceTimezone: 'America/Los_Angeles' }))
    expect(res.status).toBe(401)
  })

  it('rejects a non-admin session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'crc', name: 'Test CRC', userId: null })
    const res = await updatePracticeInfo(req('http://localhost/api/settings/practice-info', { practiceName: 'x', practiceSite: 'y', practiceTimezone: 'America/Los_Angeles' }))
    expect(res.status).toBe(403)
  })

  it('rejects an incomplete payload', async () => {
    const res = await updatePracticeInfo(req('http://localhost/api/settings/practice-info', { practiceName: 'x' }))
    expect(res.status).toBe(400)
  })

  it('saves practice info and it is reflected in the settings summary', async () => {
    const res = await updatePracticeInfo(req('http://localhost/api/settings/practice-info', { practiceName: 'IPMG Test', practiceSite: 'Redlands, CA', practiceTimezone: 'America/Los_Angeles' }))
    expect(res.status).toBe(200)
    const summary = await getSettingsSummary()
    expect(summary.practiceName).toBe('IPMG Test')
    expect(summary.practiceSite).toBe('Redlands, CA')
  })
})
