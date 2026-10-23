import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { readJsonBody } from '@/lib/http'
import { ABDM_SHARE_QUEUE_ROLES } from '@/lib/role-policy'
import { readAbdmConfig } from '@/lib/integrations/config'
import { recordProfileShare, type ShareProfile } from '@/lib/queries/abdm-profile-shares'
import { fabricatedAbhaNumber } from '@/lib/abdm/mock-adapter'
import { safeLog } from '@/lib/integrations/safe-log'
import { pgErrorCode } from '@/lib/db-errors'

// WS12 T6 (spec R14): "Simulate ABHA share" for the sandbox mock. Exists only
// when ABDM is in mock mode; otherwise 404 after the role and body checks. It
// writes an ordinary pending abdm_profile_shares row (is_mock = true), either
// copying a chart's name/DOB/gender (match path) or taking typed values
// (mismatch path). on-share is not sent: the mock has no gateway to call.

const bodySchema = z.object({
  counterId: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/).default('DESK-1'),
  likePatientId: z.string().trim().min(1).max(40).optional(),
  name: z.string().trim().min(2).max(80).optional(),
  gender: z.enum(['M', 'F', 'O']).optional(),
  yearOfBirth: z.number().int().min(1900).max(2100).optional(),
}).strict()

const SHARE_GENDER = { male: 'M', female: 'F', other: 'O', transgender: 'O' } as const

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ABDM_SHARE_QUEUE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = bodySchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const input = parsed.data

  if (readAbdmConfig().state !== 'mock') return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const requestId = randomUUID()
  const profile: ShareProfile = {
    abhaNumber: fabricatedAbhaNumber(requestId), abhaAddress: null,
    name: input.name ?? 'Sandbox Mock Patient', gender: input.gender ?? null,
    yearOfBirth: input.yearOfBirth ?? null, monthOfBirth: null, dayOfBirth: null,
    phone: null, addressLine: null, districtName: null, stateName: null, pincode: null,
  }
  if (input.likePatientId) {
    const [chart] = await getDb().select({ name: patients.name, gender: patients.gender, dob: patients.dob })
      .from(patients).where(eq(patients.id, input.likePatientId))
    if (!chart) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const [y, m, d] = chart.dob.split('-').map(Number)
    profile.name = chart.name
    profile.gender = chart.gender ? (SHARE_GENDER[chart.gender as keyof typeof SHARE_GENDER] ?? null) : null
    profile.yearOfBirth = y; profile.monthOfBirth = m; profile.dayOfBirth = d
  }

  try {
    const r = await recordProfileShare({ requestId, hipId: 'MOCK-HIP', counterId: input.counterId, intent: 'REGISTRATION', profile, isMock: true })
    await logAudit(session, 'abdm: simulated profile share', null, `share=${r.shareId} like_patient=${input.likePatientId ? 'yes' : 'no'}`)
    return NextResponse.json({ shareId: r.shareId, tokenNumber: r.tokenNumber }, { status: 201 })
  } catch (err) {
    safeLog('abdm', { action: 'share_simulate', errorCode: pgErrorCode(err) ?? 'unknown' })
    return NextResponse.json({ error: 'Could not simulate the share' }, { status: 500 })
  }
}
