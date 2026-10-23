import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { BRAND_SETTINGS_ROLES } from '@/lib/role-policy'
import { readJsonBody } from '@/lib/http'
import { RETRY_MESSAGE, isRetryableConflict } from '@/lib/db-errors'
import { brandSettingsSchema, brandValidationDetails } from '@/lib/brand-validation'
import { getBrandingAdminPayload, updateBrandSettings } from '@/lib/queries/brand-settings'
import { invalidateBrandCache } from '@/lib/brand-server'

// WL T6: Settings > Branding (spec §4.2). Admin only; the role check runs before any body read.
// The payload carries hash-addressed asset paths, never a blob URL. Logs carry the error class only.

const CONFLICT = 'Branding was changed by someone else. Reload to see their changes.'

function serverError(op: string, err: unknown, message: string) {
  if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
  console.error(`[branding] ${op} failed (${err instanceof Error ? err.name : 'UnknownError'})`)
  return NextResponse.json({ error: message }, { status: 500 })
}

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!BRAND_SETTINGS_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    return NextResponse.json(await getBrandingAdminPayload(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return serverError('read settings', err, 'Could not load the branding settings')
  }
}

export async function PUT(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!BRAND_SETTINGS_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = brandSettingsSchema.safeParse(json.body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid branding settings', details: brandValidationDetails(parsed.error) }, { status: 400 })
  }

  const { revision, ...input } = parsed.data
  let result: Awaited<ReturnType<typeof updateBrandSettings>>
  try {
    result = await updateBrandSettings(input, revision, session)
  } catch (err) {
    return serverError('save settings', err, 'Could not save the branding settings')
  }
  if (!result.ok) return NextResponse.json({ error: CONFLICT, code: 'revision_conflict' }, { status: 409 })
  invalidateBrandCache()
  return NextResponse.json({ ok: true, revision: result.revision })
}
