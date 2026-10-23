import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { BRAND_SETTINGS_ROLES } from '@/lib/role-policy'
import { readJsonBody } from '@/lib/http'
import { RETRY_MESSAGE, isRetryableConflict } from '@/lib/db-errors'
import { brandOnboardingSchema } from '@/lib/brand-validation'
import { recordOnboarding } from '@/lib/queries/brand-settings'
import { invalidateBrandCache } from '@/lib/brand-server'

// WL T6: the admin onboarding checklist: "I tested the sign-in page" or dismiss (spec §4.2).
// Admin only; the role check runs before any body read.

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!BRAND_SETTINGS_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = brandOnboardingSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid onboarding action' }, { status: 400 })

  try {
    await recordOnboarding(parsed.data.action, session)
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[branding] onboarding failed (${err instanceof Error ? err.name : 'UnknownError'})`)
    return NextResponse.json({ error: 'Could not save the onboarding step' }, { status: 500 })
  }
  invalidateBrandCache()
  return NextResponse.json({ ok: true })
}
