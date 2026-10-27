import { describe, it, expect, vi, afterAll, beforeAll } from 'vitest'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, patients } from '@/db/schema'
import { NextRequest, NextResponse } from 'next/server'
import * as auth from '@/lib/auth'

const UNAUTHORIZED = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

import { GET as listAuditLog } from '@/app/api/audit-log/route'
import { GET as exportAuditLog } from '@/app/api/audit-log/export/route'

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

// WS8 T12 (spec D19): filters, keyset pagination and the CSV export.

const RUN = Math.random().toString(36).slice(2, 8)
const MARK = `T12 Probe ${RUN}`
const CHART = `T12-${RUN}`
const UHID = `T12UH${RUN.toUpperCase()}`
const at = (iso: string) => new Date(iso)

async function purgeT12() {
  const db = getDb()
  await db.delete(auditLog).where(like(auditLog.userName, `${MARK}%`))
  await db.delete(auditLog).where(and(eq(auditLog.userName, 'Test Admin'), eq(auditLog.action, 'exported audit log')))
  await db.delete(patients).where(inArray(patients.id, [CHART]))
}

describe('WS8 T12 audit log filters and pagination', () => {
  beforeAll(async () => {
    await purgeT12()
    const db = getDb()
    await db.insert(patients).values({ id: CHART, name: 'T12 Patient', dob: '1990-01-01', uhid: UHID })
    await db.insert(auditLog).values([
      { userName: `${MARK} A`, role: 'pharmacy', action: 'dispensed drug', patientId: CHART, timestamp: at('2001-03-10T06:00:00Z') },
      { userName: `${MARK} A`, role: 'pharmacy', action: 'dispensed drug', patientId: null, timestamp: at('2001-03-12T06:00:00Z') },
      // 2001-03-11 00:10 IST is still inside a from=2001-03-11 range though it is 03-10 in UTC.
      { userName: `${MARK} B`, role: 'pharmacy', action: 'viewed stock', patientId: null, timestamp: at('2001-03-10T18:40:00Z') },
      { userName: `${MARK} C`, role: 'billing', action: 'finalised bill', patientId: CHART, timestamp: at('2001-03-11T06:00:00Z'), details: '=HYPERLINK("x")' },
    ])
    // 120 rows, 60 of them sharing one timestamp, for the tie-breaking keyset test.
    await db.execute(sql`insert into audit_log (user_name, role, action, timestamp)
      select ${`${MARK} PAGE`}, 'crc', 'paged action', case when g <= 60 then timestamp '2002-01-01 00:00:00' else timestamp '2002-01-01 00:00:00' - g * interval '1 second' end
      from generate_series(1, 120) g`)
  })
  afterAll(purgeT12)

  const list = (qs: string) => listAuditLog(new NextRequest(`http://localhost/api/audit-log?${qs}`))

  it('filters by role and an IST date range', async () => {
    const res = await list(new URLSearchParams({ user: MARK, role: 'pharmacy', from: '2001-03-11', to: '2001-03-12' }).toString())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entries.map((e: { userName: string }) => e.userName).sort()).toEqual([`${MARK} A`, `${MARK} B`])
    expect(body.entries.every((e: { role: string }) => e.role === 'pharmacy')).toBe(true)
  })

  it('resolves a UHID patient filter to the chart and shows the UHID, never the chart id', async () => {
    const res = await list(new URLSearchParams({ patient: UHID }).toString())
    const body = await res.json()
    expect(body.entries).toHaveLength(2)
    for (const e of body.entries) {
      expect(e.patientUhid).toBe(UHID)
      expect(JSON.stringify(e)).not.toContain(CHART)
    }
  })

  it('searches user, action and details with q', async () => {
    const body = await (await list(new URLSearchParams({ user: MARK, q: 'HYPERLINK' }).toString())).json()
    expect(body.entries.map((e: { userName: string }) => e.userName)).toEqual([`${MARK} C`])
  })

  it('pages 50 at a time with no overlap and no gap when timestamps tie', async () => {
    const seen: number[] = []
    let cursor: string | null = null
    const sizes: number[] = []
    do {
      const qs = new URLSearchParams({ user: `${MARK} PAGE` })
      if (cursor) qs.set('cursor', cursor)
      const body = await (await list(qs.toString())).json()
      sizes.push(body.entries.length)
      seen.push(...body.entries.map((e: { id: number }) => e.id))
      cursor = body.nextCursor
    } while (cursor)
    expect(sizes).toEqual([50, 50, 20])
    expect(new Set(seen).size).toBe(120)
  })

  it('rejects an invalid role, an unknown param and a malformed cursor with 400', async () => {
    expect((await list('role=superuser')).status).toBe(400)
    expect((await list('limit=5')).status).toBe(400)
    expect((await list('cursor=not-a-cursor')).status).toBe(400)
    expect((await list('from=2001-03-12&to=2001-03-11')).status).toBe(400)
  })
})

describe('WS8 T12 GET /api/audit-log/export', () => {
  beforeAll(async () => {
    await purgeT12()
    const db = getDb()
    await db.insert(patients).values({ id: CHART, name: 'T12 Patient', dob: '1990-01-01', uhid: UHID })
    await db.insert(auditLog).values([
      { userName: `${MARK} X`, role: 'billing', action: 'finalised bill', patientId: CHART, timestamp: at('2001-05-01T06:00:00Z'), details: '=HYPERLINK("x")' },
      { userName: `${MARK} X`, role: 'billing', action: 'printed bill', patientId: null, timestamp: at('2001-05-02T06:00:00Z') },
    ])
  })
  afterAll(purgeT12)

  const exp = (qs: string) => exportAuditLog(new NextRequest(`http://localhost/api/audit-log/export?${qs}`))

  it('returns 403 for a non-admin session', async () => {
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pharmacy', name: 'Test Pharmacy', userId: null })
    expect((await exp('')).status).toBe(403)
  })

  it('streams a formula-safe CSV with a UHID column and writes its own audit row with filter keys and row count only', async () => {
    const res = await exp(new URLSearchParams({ user: `${MARK} X`, from: '2001-05-01', to: '2001-05-02' }).toString())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="audit-log-2001-05-01-2001-05-02.csv"')
    const text = await res.text()
    const lines = text.split('\r\n')
    expect(lines[0]).toBe('timestamp_ist,user,role,action,patient_uhid,details')
    expect(lines).toHaveLength(4)
    expect(text).toContain(`"${UHID}"`)
    expect(text).not.toContain(CHART)
    expect(text).toContain(`"'=HYPERLINK(""x"")"`)
    const rows = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, 'Test Admin'), eq(auditLog.action, 'exported audit log')))
    expect(rows).toHaveLength(1)
    expect(rows[0].details).toBe('filters=user,from,to rows=2')
    expect(rows[0].details).not.toContain(MARK)
  })

  it('rejects an invalid role with 400', async () => {
    expect((await exp('role=superuser')).status).toBe(400)
  })

  it('refuses more than 50,000 rows with 422 "Narrow the filters"', async () => {
    await getDb().execute(sql`insert into audit_log (user_name, role, action, timestamp)
      select ${`${MARK} BULK`}, 'crc', 'bulk', timestamp '2003-01-01 00:00:00' + g * interval '1 second' from generate_series(1, 50001) g`)
    const res = await exp(new URLSearchParams({ user: `${MARK} BULK` }).toString())
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('Narrow the filters')
  }, 30_000)
})
