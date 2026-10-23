// Foundations T9: Send Form to Client also notifies the patient through sendNotification.
import { describe, it, expect, vi, afterAll, beforeAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, formSubmissions, formTemplates, notificationLog, patients } from '@/db/schema'
import { makeFakeRegistry } from '../helpers/notify-fakes'

const fake = makeFakeRegistry()
vi.mock('@/lib/notify/registry', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/notify/registry')>()), getChannelRegistry: () => fake.registry }))
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'crc', name: 'T9 Form Sender', userId: null })) }))

const { POST } = await import('@/app/api/form-submissions/route')
const { sendPatientNotice } = await import('@/lib/queries/notifications')

const PID = `TEST-T9F-${Date.now()}`
let templateId = 0
const post = (body: unknown) => POST(new Request('http://localhost/api/form-submissions', { method: 'POST', body: JSON.stringify(body) }) as never)
const logs = () => getDb().select().from(notificationLog).where(eq(notificationLog.patientId, PID))

describe.skipIf(!process.env.DATABASE_URL)('POST /api/form-submissions notifies', () => {
  beforeAll(async () => {
    await getDb().insert(patients).values({ id: PID, name: 'TEST_T9 Form', dob: '1980-01-01', phone: '+919845013210' })
    const [t] = await getDb().insert(formTemplates).values({ name: `T9 form ${Date.now()}`, category: 'Uncategorized', diagnosisTag: 'test', questions: [] }).returning()
    templateId = t.id
  })
  afterAll(async () => {
    const db = getDb()
    await db.delete(notificationLog).where(eq(notificationLog.patientId, PID))
    await db.delete(formSubmissions).where(eq(formSubmissions.patientId, PID))
    await db.delete(formTemplates).where(eq(formTemplates.id, templateId))
    await db.delete(auditLog).where(eq(auditLog.userName, 'T9 Form Sender'))
    await db.delete(patients).where(inArray(patients.id, [PID]))
  })

  it('records a form_sent attempt, still returns the link token, and carries no token in the log', async () => {
    const res = await post({ templateId, patientId: PID })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(typeof body.accessToken).toBe('string')
    const rows = await logs()
    expect(rows.filter((r) => r.templateKey === 'form_sent').map((r) => [r.channel, r.status, r.dedupeKey])).toEqual([
      ['sms', 'sent', `form:${body.id}`],
      ['whatsapp', 'sent', `form:${body.id}`],
    ])
    expect(JSON.stringify(rows)).not.toContain(body.accessToken)
    expect(JSON.stringify(fake.sends.sms.mock.calls)).not.toContain(body.accessToken)
    expect(fake.sends.sms).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('patient portal') }))
  })

  it('a retried notice for the same submission sends nothing more', async () => {
    const res = await post({ templateId, patientId: PID })
    const { id } = await res.json()
    fake.sends.sms.mockClear()
    const again = await sendPatientNotice({ patientId: PID, templateKey: 'form_sent', vars: { hospitalName: 'H' }, dedupeKey: `form:${id}` })
    expect(again?.deduped).toBe(true)
    expect(fake.sends.sms).not.toHaveBeenCalled()
  })

  it('a failing channel does not fail the send; the failure is recorded', async () => {
    fake.sends.sms.mockResolvedValueOnce({ ok: false, errorClass: 'provider_down' })
    const res = await post({ templateId, patientId: PID })
    expect(res.status).toBe(201)
    const { id } = await res.json()
    expect((await logs()).find((r) => r.dedupeKey === `form:${id}` && r.channel === 'sms')).toMatchObject({ status: 'failed', errorClass: 'provider_down' })
  })

  it('a throwing notification service does not fail the send', async () => {
    fake.sends.sms.mockRejectedValueOnce(new Error('boom'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post({ templateId, patientId: PID })
    err.mockRestore()
    expect(res.status).toBe(201)
  })
})
