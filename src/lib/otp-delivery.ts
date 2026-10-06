import { createHash, randomInt, timingSafeEqual } from 'crypto'
import { getRedis } from '@/lib/cache'
import { sendSms } from '@/lib/sms'
import { sendEmail } from '@/lib/email'
import { brand } from '@/lib/brand'

const OTP_TTL_SECONDS = 300 // 5 minutes, matches the copy shown to the user

function otpKey(identity: string, channel: 'sms' | 'email'): string {
  return `otp:${channel}:${identity}`
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

export async function generateAndSendOtp(identity: string, channel: 'sms' | 'email', destination: string): Promise<void> {
  const code = String(randomInt(100000, 1000000))
  await getRedis().set(otpKey(identity, channel), hashCode(code), { ex: OTP_TTL_SECONDS })

  if (channel === 'sms') {
    await sendSms(destination, code)
  } else {
    await sendEmail(destination, `Your ${brand.name} verification code`, `Your verification code is ${code}. It expires in 5 minutes.`)
  }
}

export async function verifyOtp(identity: string, channel: 'sms' | 'email', code: string): Promise<boolean> {
  const key = otpKey(identity, channel)
  const stored = await getRedis().get<string>(key)
  if (!stored) return false

  const candidate = Buffer.from(hashCode(code))
  const expected = Buffer.from(stored)
  const matches = candidate.length === expected.length && timingSafeEqual(candidate, expected)
  if (!matches) return false

  // Single-use: delete on first successful match so a resubmitted or
  // intercepted code can never be replayed, same intent as TOTP's replay
  // guard in src/lib/mfa.ts, simpler here since there's exactly one valid
  // value at a time rather than a rolling time-window of them.
  await getRedis().del(key)
  return true
}
