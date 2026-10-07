import { describe, it, expect, vi } from 'vitest'
import { POST as createAppointment } from '@/app/api/appointments/route'
import { PUT as updateAppointment } from '@/app/api/appointments/[id]/route'
import { POST as scheduleAssignment } from '@/app/api/front-desk/assignments/[id]/schedule/route'
import { PATCH as confirmBooking } from '@/app/api/booking-requests/[id]/confirm/route'
import { INVALID_APPOINTMENT_TIME } from '@/lib/appointment-time'

// Wave A (P0-03): every appointment-writing route requires an explicit UTC
// offset. A naive "2026-11-03T09:00:00" means 09:00 in whatever zone the server
// runs in (UTC on Vercel = 14:30 IST), so it is rejected with the same fixed
// 400 the SP3 follow-up booking route uses -- before any DB work.
const sessionRef = vi.hoisted(() => ({ current: { role: 'admin', name: 'Asha Admin' } as { role: string; name: string } }))
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => sessionRef.current) }))

const NAIVE = { startsAt: '2026-11-03T09:00:00', endsAt: '2026-11-03T09:30:00' }
const DATE_ONLY = { startsAt: '2026-11-03', endsAt: '2026-11-04' }
const body = (b: unknown, method = 'POST') => new Request('http://localhost', { method, body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } })
const params = (id: string) => ({ params: Promise.resolve({ id }) })

async function expectFixed400(res: Response) {
  expect(res.status).toBe(400)
  expect((await res.json()).error).toBe(INVALID_APPOINTMENT_TIME)
}

describe('appointment routes reject naive date-times (no UTC offset)', () => {
  it.each([NAIVE, DATE_ONLY])('POST /api/appointments %j', async (times) => {
    sessionRef.current = { role: 'admin', name: 'Asha Admin' }
    await expectFixed400(await createAppointment(body({ patientId: 'RD-0001', providerId: 1, visitReason: 'Fever', ...times }) as never))
  })

  it('PUT /api/appointments/[id] with only a naive startsAt', async () => {
    sessionRef.current = { role: 'admin', name: 'Asha Admin' }
    await expectFixed400(await updateAppointment(body({ startsAt: NAIVE.startsAt }, 'PUT') as never, params('999999999')))
  })

  it('PUT /api/appointments/[id] with only a naive endsAt', async () => {
    sessionRef.current = { role: 'admin', name: 'Asha Admin' }
    await expectFixed400(await updateAppointment(body({ endsAt: NAIVE.endsAt }, 'PUT') as never, params('999999999')))
  })

  it('POST /api/front-desk/assignments/[id]/schedule', async () => {
    sessionRef.current = { role: 'pi', name: 'Dr. Meera Rao' }
    await expectFixed400(await scheduleAssignment(body(NAIVE) as never, params('999999999')))
  })

  it('PATCH /api/booking-requests/[id]/confirm', async () => {
    sessionRef.current = { role: 'frontdesk', name: 'Front Desk' }
    await expectFixed400(await confirmBooking(body({ patientId: 'RD-0001', providerId: 1, visitReason: 'Fever', ...NAIVE }, 'PATCH') as never, params('999999999')))
  })
})
