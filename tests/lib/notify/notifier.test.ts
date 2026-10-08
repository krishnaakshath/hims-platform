import { describe, it, expect, vi } from 'vitest'
import { createLogOnlyNotifier, getNotifier, maskDestination } from '@/lib/notify/notifier'

describe('notifier', () => {
  it('log-only notifier logs ids and a masked number, never the text', async () => {
    const lines: string[] = []
    const r = await createLogOnlyNotifier((l) => lines.push(l)).send({ patientId: 'RD-0007', templateKey: 'lab_report_ready', text: 'SECRET', destination: '+919845013210' })
    expect(r).toEqual({ channel: 'log', delivered: false })
    expect(lines).toEqual(['[notify] template=lab_report_ready patient=RD-0007 to=+91******3210 channel=log delivered=false'])
  })

  it('masks every digit but the last four', () => {
    expect(maskDestination('+919845013210')).toBe('+91******3210')
    expect(maskDestination('+447911123456')).toBe('+********3456')
    expect(maskDestination('123')).toBe('***')
  })

  it('the default notifier is log-only and writes to console.info', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const r = await getNotifier().send({ patientId: 'RD-1', templateKey: 'lab_tests_ordered', text: 'TEXT-NOT-LOGGED', destination: '+919845013210' })
    expect(r).toEqual({ channel: 'log', delivered: false })
    expect(info).toHaveBeenCalledTimes(1)
    expect(String(info.mock.calls[0][0])).not.toContain('TEXT-NOT-LOGGED')
    expect(String(info.mock.calls[0][0])).not.toContain('9845013210')
    info.mockRestore()
  })
})
