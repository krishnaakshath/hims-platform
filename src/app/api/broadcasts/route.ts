import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { broadcasts } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listBroadcasts, listBroadcastRecipientCandidates, simulateBroadcastDelivery, invalidateBroadcastsList } from '@/lib/queries/broadcasts'

const createBroadcastSchema = z
  .object({
    subject: z.string().min(1).optional(),
    message: z.string().min(1).max(1000),
    channel: z.enum(['sms', 'email', 'both']),
    filterTrialId: z.string().min(1).optional(),
    filterOverallStatus: z.enum(['green', 'yellow', 'red']).optional(),
    filterFormStatus: z.enum(['sent', 'partial', 'completed', 'none']).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.channel === 'sms' && data.message.length > 140) {
      ctx.addIssue({ code: 'custom', message: 'SMS messages must be 140 characters or fewer', path: ['message'] })
    }
    if ((data.channel === 'email' || data.channel === 'both') && !data.subject) {
      ctx.addIssue({ code: 'custom', message: 'Subject is required when sending email', path: ['subject'] })
    }
  })

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // LeftNav.tsx:62 — { href: '/broadcasts', roles: ['admin', 'crc'] }
  if (!['admin', 'crc'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  await logAudit(session, 'viewed broadcasts list', null)
  return NextResponse.json(await listBroadcasts())
}

// Sends a (simulated) broadcast to a patient cohort — LeftNav.tsx:62 —
// { href: '/broadcasts', roles: ['admin', 'crc'] }
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = createBroadcastSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid broadcast payload', details: parsed.error.flatten() }, { status: 400 })

  const candidates = await listBroadcastRecipientCandidates({
    trialId: parsed.data.filterTrialId,
    overallStatus: parsed.data.filterOverallStatus,
    formStatus: parsed.data.filterFormStatus,
  })
  if (candidates.length === 0) {
    return NextResponse.json({ error: 'No patients match this recipient filter' }, { status: 400 })
  }

  const recipients = candidates.map((c) => ({
    patientId: c.id,
    patientName: c.name,
    deliveryStatus: simulateBroadcastDelivery(parsed.data.channel, c.phone, c.email),
  }))

  const [created] = await getDb()
    .insert(broadcasts)
    .values({
      subject: parsed.data.subject ?? null,
      message: parsed.data.message,
      channel: parsed.data.channel,
      filterTrialId: parsed.data.filterTrialId ?? null,
      filterOverallStatus: parsed.data.filterOverallStatus ?? null,
      filterFormStatus: parsed.data.filterFormStatus ?? null,
      recipients,
      recipientCount: recipients.length,
      sentBy: session.name,
    })
    .returning()

  await invalidateBroadcastsList()
  await logAudit(session, `sent broadcast to ${recipients.length} patient(s)`, null)
  return NextResponse.json(created, { status: 201 })
}
