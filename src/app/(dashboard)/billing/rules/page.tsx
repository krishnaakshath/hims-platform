import { redirect } from 'next/navigation'
import { SlidersHorizontal } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { BILLING_CONFIG_ROLES, CHARGE_CAPTURE_ROLES } from '@/lib/role-policy'
import { getBillingSettings, listRuleRows } from '@/lib/queries/billing-settings'
import { listServices } from '@/lib/queries/tariff'
import { listPayers } from '@/lib/queries/payers'
import { RuleConfigTable } from '@/components/billing/RuleConfigTable'
import { BillingSettingsForm } from '@/components/billing/BillingSettingsForm'
import { PayerFlagsTable } from '@/components/billing/PayerFlagsTable'

// SP4: billing rules and settings. Every BILLING_ROLES member may read; only BILLING_CONFIG_ROLES
// (admin) may change them -- the department being policed does not switch its own controls off.
// Configuration only (no PHI), so not audited.
export default async function BillingRulesPage() {
  const session = await requireSessionOrRedirect()
  if (!CHARGE_CAPTURE_ROLES.includes(session.role)) redirect('/')

  const editable = BILLING_CONFIG_ROLES.includes(session.role)
  const [rows, settings, roomServices, payerRows] = await Promise.all([
    listRuleRows(), getBillingSettings(), listServices({ category: 'room_rent', limit: 200 }), listPayers(),
  ])

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true"><SlidersHorizontal className="h-5 w-5" /></span>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Billing Rules &amp; Settings</h1>
          <p className="text-sm text-muted-foreground">{editable ? 'Changes apply to new charges and invoices straight away.' : 'Read-only: an administrator manages these.'}</p>
        </div>
      </div>
      <section>
        <h2 className="mb-2 text-lg font-semibold">Charge rules</h2>
        <RuleConfigTable rows={rows} editable={editable} />
      </section>
      <section>
        <h2 className="mb-2 text-lg font-semibold">Hospital billing settings</h2>
        <div className="rounded-lg border border-border bg-card p-4">
          <BillingSettingsForm
            settings={{
              legalName: settings.legalName, gstin: settings.gstin, stateCode: settings.stateCode, address: settings.address, placeOfSupplyMode: settings.placeOfSupplyMode,
              consultationWindowDays: settings.consultationWindowDays, ipdDepositThresholdPaise: settings.ipdDepositThresholdPaise,
              roomRentServiceId: settings.roomRentServiceId, pharmacyGstRateBp: settings.pharmacyGstRateBp, pharmacyHsn: settings.pharmacyHsn,
            }}
            roomRentServices={roomServices.map((s) => ({ id: s.id, code: s.code, name: s.name }))}
            editable={editable}
          />
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-lg font-semibold">Payer billing flags</h2>
        <PayerFlagsTable payers={payerRows.map((p) => ({ id: p.id, name: p.name, requiresPreauth: p.requiresPreauth, gstin: p.gstin, stateCode: p.stateCode }))} editable={editable} />
      </section>
    </div>
  )
}
