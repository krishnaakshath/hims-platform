// Foundations T9: starting a video visit sends video_visit_link once; recovery on 409 sends nothing.
import { describe, it, expect, vi, afterAll, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { appointments, auditLog, notificationLog, patients, telemedicineSessions, telemedicineSignals } from '@/db/schema'
import { makeFakeRegistry } from '../helpers/notify-fakes'

const fake = makeFakeRegistry()
vi.mock('@/lib/notify/registry', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/notify/registry')>()), getChannelRegistry: () => fake.registry }))
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'admin', name: 'T9 Video Admin', userId: null })) }))

const { POST } = await import('@/app/api/appointments/[id]/telemedicine/route')

const PID = `TEST-T9V-${Date.now()}`
let apptId = 0
const start = () => POST(new Request('http://localhost', { method: 'POST' }) as never, { params: Promise.resolve({ id: String(apptId) }) })
const logs = () => getDb().select().from(notificationLog).where(eq(notificationLog.patientId, PID))

describe.skipIf(!process.env.DATABASE_URL)('POST /api/appointments/[id]/telemedicine notifies', () => {
  beforeAll(async () => {
    await getDb().insert(patients).values({ id: PID, name: 'TEST_T9 Video', dob: '1980-01-01', phone: '+919845013211' })
    const [a] = await getDb().insert(appointments).values({ patientId: PID, providerId: 1, startsAt: new Date('2099-03-04T04:30:00Z'), endsAt: new Date('2099-03-04T05:00:00Z'), visitReason: 'T9 video', visitMode: 'video' /* WS7 T6 */ }).returning()
    apptId = a.id
  })
  afterAll(async () => {
    const db = getDb()
    const [s] = await db.select().from(telemedicineSessions).where(eq(telemedicineSessions.appointmentId, apptId))
    await db.delete(notificationLog).where(eq(notificationLog.patientId, PID))
    if (s) { await db.delete(telemedicineSignals).where(eq(telemedicineSignals.sessionId, s.id)); await db.delete(telemedicineSessions).where(eq(telemedicineSessions.id, s.id)) }
    await db.delete(appointments).where(eq(appointments.id, apptId))
    await db.delete(auditLog).where(eq(auditLog.userName, 'T9 Video Admin'))
    await db.delete(patients).where(eq(patients.id, PID))
  })

  it('records video_visit_link, returns the join token, and keeps the token out of text and log', async () => {
    const res = await start()
    expect(res.status).toBe(201)
    const body = await res.json()
    const rows = await logs()
    expect(rows.map((r) => [r.templateKey, r.channel, r.status, r.dedupeKey])).toEqual([
      ['video_visit_link', 'sms', 'sent', `video:${body.id}`],
      ['video_visit_link', 'whatsapp', 'sent', `video:${body.id}`],
    ])
    const text = (fake.sends.sms.mock.calls[0] as unknown as [{ text: string }])[0].text
    expect(text).toContain('4 Mar 2099')
    expect(text).not.toContain(body.patientJoinToken)
    expect(JSON.stringify(rows)).not.toContain(body.patientJoinToken)
  })

  it('a retried start recovers the session on 409 and sends nothing more', async () => {
    fake.sends.sms.mockClear()
    fake.sends.whatsapp.mockClear()
    const res = await start()
    expect(res.status).toBe(409)
    expect((await res.json()).patientJoinToken).toBeTruthy()
    expect(fake.sends.sms).not.toHaveBeenCalled()
    expect(fake.sends.whatsapp).not.toHaveBeenCalled()
    expect(await logs()).toHaveLength(2)
  })
})
