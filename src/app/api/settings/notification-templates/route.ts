import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { pgConstraint, pgErrorCode } from '@/lib/db-errors'
import { DELIVERY_CHANNELS } from '@/lib/notify/registry'
import { NOTIFICATION_TEMPLATE_KEYS } from '@/lib/notify/templates'
import { upsertNotificationTemplateConfig } from '@/lib/queries/notification-log'

// Foundations T8: per-template notification channels plus the provider-side ids (India DLT
// template id, WhatsApp template name). Admin only. Credentials never travel through here:
// they live in env. The audit entry is written with the change (upsertNotificationTemplateConfig).
const schema = z
  .object({
    templateKey: z.enum(NOTIFICATION_TEMPLATE_KEYS),
    channels: z.array(z.enum(DELIVERY_CHANNELS)).max(DELIVERY_CHANNELS.length).refine((c) => new Set(c).size === c.length, 'Duplicate channel'),
    dltTemplateId: z.string().regex(/^\d{1,30}$/, 'DLT template id is digits only').nullable(),
    whatsappTemplateName: z.string().regex(/^[a-z0-9_]{1,512}$/, 'Lowercase letters, digits and underscores').nullable(),
  })
  .strict()

export async function PUT(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = schema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  try {
    const config = await upsertNotificationTemplateConfig(parsed.data, session)
    return NextResponse.json({ ok: true, config })
  } catch (err) {
    console.error(`[settings] notification template update failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Could not save the notification template' }, { status: 500 })
  }
}
