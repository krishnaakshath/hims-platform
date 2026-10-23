// Foundations T9: GET /api/patients/[anonId]/notices (admin, crc, pi, frontdesk; no bodies).
import { describe, it, expect, vi, afterAll, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, notificationLog, patients } from '@/db/schema'

let role = 'crc'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: 'T9 Notices Viewer', userId: null })) }))
const { GET } = await import('@/app/api/patients/[anonId]/notices/route')

const PID = `TEST-T9N-${Date.now()}`
const call = (id = PID) => GET(new Request('http://localhost') as never, { params: Promise.resolve({ anonId: id }) })

describe.skipIf(!process.env.DATABASE_URL)('GET /api/patients/[anonId]/notices', () => {
  beforeAll(async () => {
    await getDb().insert(patients).values({ id: PID, name: 'TEST_T9 Notices', dob: '1980-01-01' })
    await getDb().insert(notificationLog).values([
      { patientId: PID, templateKey: 'form_sent', channel: 'sms', status: 'sent', destinationMasked: '+91******3210', providerMessageId: 'SMSECRET' },
      { patientId: PID, templateKey: 'lab_report_ready', channel: 'whatsapp', status: 'failed', errorClass: 'provider_down' },
    ])
  })
  afterAll(async () => {
    await getDb().delete(notificationLog).where(eq(notificationLog.patientId, PID))
    await getDb().delete(auditLog).where(eq(auditLog.userName, 'T9 Notices Viewer'))
    await getDb().delete(patients).where(eq(patients.id, PID))
  })

  it.each(['admin', 'crc', 'pi', 'frontdesk'])('%s gets templateKey/channel/status/createdAt only, newest first, and is audited', async (r) => {
    role = r
    const res = await call()
    expect(res.status).toBe(200)
    const { items } = await res.json()
    expect(items.map((i: { templateKey: string }) => i.templateKey)).toEqual(['lab_report_ready', 'form_sent'])
    for (const i of items) expect(Object.keys(i).sort()).toEqual(['channel', 'createdAt', 'status', 'templateKey'])
    expect(JSON.stringify(items)).not.toMatch(/SMSECRET|3210|provider_down/)
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, 'T9 Notices Viewer'))
    expect(audits.some((a) => a.patientId === PID && a.action === 'viewed patient notices')).toBe(true)
  })

  it.each(['labs', 'billing', 'nurse'])('%s is forbidden', async (r) => {
    role = r
    const res = await call()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('404s an unknown patient', async () => {
    role = 'admin'
    expect((await call('TEST-T9N-NOPE')).status).toBe(404)
  })
})
