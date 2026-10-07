import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { BILLING_CONFIG_ROLES } from '@/lib/role-policy'
import { CHARGE_RULE_CODES, type ChargeRuleCode } from '@/lib/billing/charge-rules'
import { ruleConfigSchema } from '@/lib/billing/validation'
import { setRuleConfig } from '@/lib/queries/billing-settings'
import { billingError, billingServerError, invalid, readJsonBody } from '@/lib/billing/route-responses'

const isRuleCode = (code: string): code is ChargeRuleCode => (CHARGE_RULE_CODES as readonly string[]).includes(code)

// SP4: switch a configurable charge rule on or off, or re-grade it (block / warn / table default).
export async function PUT(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!BILLING_CONFIG_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = ruleConfigSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid rule setting')

  const { code } = await params
  if (!isRuleCode(code)) return billingError(404, 'Unknown rule')

  try {
    const result = await setRuleConfig(code, parsed.data, session)
    if (!result.ok) return billingError(400, 'This rule cannot be changed')
    return NextResponse.json({ ok: true })
  } catch (err) {
    return billingServerError('update rule', err, 'Could not save the rule')
  }
}
