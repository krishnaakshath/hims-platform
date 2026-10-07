import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))

import { logAudit } from '@/lib/audit'
import { createLogOnlyFollowUpNotifier, notifyFollowUpSafely, getFollowUpNotifier, type FollowUpNotice } from '@/lib/follow-ups/notifier'
import type { Session } from '@/lib/auth'

const SESSION = { name: 'Front Desk', role: 'frontdesk' } as unknown as Session
const NOTICE: FollowUpNotice = { kind: 'booked', followUpOrderId: 12, patientId: 'RD-0007', dueDate: '2026-10-21', appointmentStartsAt: new Date('2026-10-21T04:00:00Z') }

describe('follow-up notifier', () => {
  it('logs ids only and reports not delivered', async () => {
    const lines: string[] = []
    const res = await createLogOnlyFollowUpNotifier((l) => lines.push(l)).notify(NOTICE)
    expect(res).toEqual({ channel: 'log', delivered: false })
    expect(lines).toEqual(['[follow-up notice] kind=booked order=12 patient=RD-0007 due=2026-10-21 appt=2026-10-21T04:00:00.000Z channel=log delivered=false'])
  })
  it('writes appt=none without an appointment', async () => {
    const lines: string[] = []
    await createLogOnlyFollowUpNotifier((l) => lines.push(l)).notify({ ...NOTICE, kind: 'planned', appointmentStartsAt: null })
    expect(lines[0]).toContain('appt=none')
  })
  it('notifyFollowUpSafely audits and swallows notifier errors', async () => {
    vi.mocked(logAudit).mockClear()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(notifyFollowUpSafely(SESSION, NOTICE, { notify: async () => { throw new Error('boom') } })).resolves.toBeUndefined()
    expect(logAudit).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalledWith('[follow-up notice] failed', 'Error')
    err.mockRestore()
    await notifyFollowUpSafely(SESSION, NOTICE, createLogOnlyFollowUpNotifier(() => {}))
    expect(logAudit).toHaveBeenCalledWith(SESSION, 'follow-up notice (log only)', 'RD-0007', 'followUp=12 kind=booked delivered=false')
  })
  it('swallows an audit failure too', async () => {
    vi.mocked(logAudit).mockRejectedValueOnce(new Error('db down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(notifyFollowUpSafely(SESSION, NOTICE, createLogOnlyFollowUpNotifier(() => {}))).resolves.toBeUndefined()
    err.mockRestore()
  })
  it('default notifier is log only', () => { expect(typeof getFollowUpNotifier().notify).toBe('function') })
})
