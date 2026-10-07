import { UserCircle2 } from 'lucide-react'
import type { Role } from '@/lib/auth'
import { ROLE_CAPABILITIES } from '@/lib/role-capabilities'
import type { OwnAccount } from '@/lib/queries/own-account'
import { MfaMethodPicker } from '@/components/settings/MfaMethodPicker'
import { StaffMfaSelfResetForm } from '@/components/settings/StaffMfaSelfResetForm'

const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'
const HEADING = 'mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

/** The signed-in staff member's own account: identity, capabilities and
 *  two-factor controls. Shared by /account (every role) and Settings. */
export function AccountPanel({ name, role, account }: { name: string; role: Role; account: OwnAccount }) {
  const capabilities = ROLE_CAPABILITIES[role]
  return (
    <div className="space-y-4">
      <section className={SECTION} aria-label="Signed-in user">
        <div className="flex items-center gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
            <UserCircle2 className="h-6 w-6" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">{name}</p>
            <p className="text-xs text-muted-foreground">{capabilities.label}</p>
            {account.email && <p className="text-xs text-muted-foreground">{account.email}</p>}
          </div>
        </div>
      </section>
      <section className={SECTION} aria-labelledby="account-capabilities">
        <h2 id="account-capabilities" className={HEADING}>What you can do</h2>
        <p className="mb-3 text-sm text-foreground">{capabilities.summary}</p>
        <ul className="list-disc space-y-1.5 ps-5 text-sm text-muted-foreground">
          {capabilities.bullets.map((b) => <li key={b}>{b}</li>)}
        </ul>
      </section>
      <section className={SECTION} aria-labelledby="account-security">
        <h2 id="account-security" className={HEADING}>Two-factor sign-in</h2>
        <p className="mb-3 text-sm text-muted-foreground">Two-factor authentication is required for every staff account. You can change how you receive your code, or, if you&apos;ve lost your device, reset it here and set it up again on your next sign-in.</p>
        {account.email ? (
          <div className="space-y-3">
            <MfaMethodPicker email={account.email} currentMethod={account.mfaMethod} currentPhone={account.phone} />
            <StaffMfaSelfResetForm email={account.email} />
          </div>
        ) : (
          <p role="status" className="text-sm text-warning">Your staff account record could not be found. Ask an administrator to check your account.</p>
        )}
      </section>
    </div>
  )
}
