'use client'
import { AlertTriangle, OctagonX } from 'lucide-react'
import { CHARGE_RULES, type ChargeRuleCode, type ChargeViolation } from '@/lib/billing/charge-rules'
import { FIELD_CLASS } from '@/components/tariff/api'

const RULE_LABEL = new Map(CHARGE_RULES.map((r) => [r.code, r.label]))
const FIELD_LABEL: Record<string, string> = {
  serviceId: 'Service', quantity: 'Quantity', serviceDate: 'Service date', unitPrice: 'Price',
  preAuthReference: 'Pre-authorisation', procedureCodes: 'Procedure codes', context: 'Visit or stay',
}

/**
 * SP4: the rule results for a charge. Blocks in red, warnings in amber. An overridable block gets an
 * override-reason input, but only for billing authority roles (`canOverride`).
 */
export function ViolationList({ violations, canOverride, overrideReasons = {}, onOverrideReason }: {
  violations: ChargeViolation[]
  canOverride: boolean
  overrideReasons?: Partial<Record<ChargeRuleCode, string>>
  onOverrideReason?: (code: ChargeRuleCode, reason: string) => void
}) {
  if (violations.length === 0) return null
  return (
    <ul className="space-y-2" aria-label="Billing rule checks">
      {violations.map((v, i) => {
        const block = v.severity === 'block'
        const Icon = block ? OctagonX : AlertTriangle
        const label = RULE_LABEL.get(v.code) ?? v.code
        return (
          <li key={`${v.code}-${i}`} className={`rounded-md border px-3 py-2 text-sm ${block ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200' : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'}`}>
            <div className="flex items-start gap-2">
              <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{v.message}</p>
                <p className="text-xs opacity-80">{block ? 'Blocks the charge' : 'Warning'} · {FIELD_LABEL[v.field] ?? v.field}</p>
                {block && v.overridable && canOverride && onOverrideReason && (
                  <input
                    aria-label={`Override reason: ${label}`}
                    placeholder="Reason to override (at least 5 characters)"
                    value={overrideReasons[v.code] ?? ''}
                    onChange={(e) => onOverrideReason(v.code, e.target.value)}
                    maxLength={300}
                    className={`${FIELD_CLASS} mt-2 bg-background text-foreground`}
                  />
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
