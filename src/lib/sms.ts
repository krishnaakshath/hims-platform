import { getBrand } from '@/lib/brand-server'

export async function sendSms(toPhone: string, code: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const fromNumber = process.env.TWILIO_FROM_NUMBER
  if (!accountSid || !authToken || !fromNumber) {
    throw new Error('SMS sign-in is not configured (missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER).')
  }

  // Spec D14: the SMS name (smsName, else the display name), read per request.
  const { smsName } = await getBrand()
  const body = new URLSearchParams({
    To: toPhone,
    From: fromNumber,
    Body: `Your ${smsName} verification code is ${code}. It expires in 5 minutes.`,
  })

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
    },
    body,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Failed to send SMS via Twilio (${res.status}): ${detail}`)
  }
}
