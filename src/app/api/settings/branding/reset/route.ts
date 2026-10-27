import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { BRAND_SETTINGS_ROLES } from '@/lib/role-policy'
import { rejectCrossOrigin } from '@/lib/csrf'
import { readJsonBody } from '@/lib/http'
import { RETRY_MESSAGE, isRetryableConflict } from '@/lib/db-errors'
import { brandResetSchema } from '@/lib/brand-validation'
import { resetBrandSettingsAt } from '@/lib/queries/brand-settings'
import { invalidateBrandCache } from '@/lib/brand-server'

// WL T6: reset branding to the env/built-in defaults (spec §4.2, §6). Admin only, role check before
// any body read; also rejects a cross-origin POST. Guarded by the revision the admin confirmed.

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!BRAND_SETTINGS_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const crossOrigin = rejectCrossOrigin(request)
  if (crossOrigin) return crossOrigin

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = brandResetSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Type RESET to confirm' }, { status: 400 })

  let result: Awaited<ReturnType<typeof resetBrandSettingsAt>>
  try {
    result = await resetBrandSettingsAt(parsed.data.revision, session)
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[branding] reset failed (${err instanceof Error ? err.name : 'UnknownError'})`)
    return NextResponse.json({ error: 'Could not reset the branding' }, { status: 500 })
  }
  if (!result.ok) {
    return NextResponse.json(
      { error: 'Branding was changed by someone else. Reload to see their changes.', code: 'revision_conflict' }, { status: 409 },
    )
  }
  invalidateBrandCache()
  return NextResponse.json({ ok: true, revision: result.revision })
}
