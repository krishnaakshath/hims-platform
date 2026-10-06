import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateAndSendOtp, verifyOtp } from '@/lib/otp-delivery'

vi.mock('@/lib/sms', () => ({ sendSms: vi.fn(async () => undefined) }))
vi.mock('@/lib/email', () => ({ sendEmail: vi.fn(async () => undefined) }))

afterEach(() => {
  vi.clearAllMocks()
})

describe('generateAndSendOtp / verifyOtp', () => {
  it('sends via sendSms for the sms channel', async () => {
    const { sendSms } = await import('@/lib/sms')
    await generateAndSendOtp('test-identity-1', 'sms', '+15551234567')
    expect(sendSms).toHaveBeenCalledTimes(1)
    const [toPhone] = vi.mocked(sendSms).mock.calls[0]
    expect(toPhone).toBe('+15551234567')
  })

  it('sends via sendEmail for the email channel', async () => {
    const { sendEmail } = await import('@/lib/email')
    await generateAndSendOtp('test-identity-2', 'email', 'staff@example.com')
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const [toEmail] = vi.mocked(sendEmail).mock.calls[0]
    expect(toEmail).toBe('staff@example.com')
  })

  it('verifies the exact code that was sent, and rejects a wrong code', async () => {
    const { sendSms } = await import('@/lib/sms')
    await generateAndSendOtp('test-identity-3', 'sms', '+15551234567')
    const [, sentCode] = vi.mocked(sendSms).mock.calls[0]
    expect(await verifyOtp('test-identity-3', 'sms', '000000')).toBe(false)
    expect(await verifyOtp('test-identity-3', 'sms', sentCode)).toBe(true)
  })

  it('rejects a code that was already successfully verified once (single-use)', async () => {
    const { sendSms } = await import('@/lib/sms')
    await generateAndSendOtp('test-identity-4', 'sms', '+15551234567')
    const [, sentCode] = vi.mocked(sendSms).mock.calls[0]
    expect(await verifyOtp('test-identity-4', 'sms', sentCode)).toBe(true)
    expect(await verifyOtp('test-identity-4', 'sms', sentCode)).toBe(false)
  })
})
