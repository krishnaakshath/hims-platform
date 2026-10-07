import { Building, Building2, SlidersHorizontal, UserCircle2, Users, IdCard, Monitor } from 'lucide-react'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { getSettingsSummary } from '@/lib/queries/settings'
import { getOwnAccount } from '@/lib/queries/own-account'
import { AccountPanel } from '@/components/account/AccountPanel'
import { listAllProviders } from '@/lib/queries/providers'
import { listAllUsers } from '@/lib/queries/users'
import { listDepartments } from '@/lib/queries/departments'
import { AutoClassifyToggle } from '@/components/AutoClassifyToggle'
import { QueueDisplayPinForm } from '@/components/QueueDisplayPinForm'
import { PracticeInfoForm } from '@/components/PracticeInfoForm'
import { UhidPrefixForm } from '@/components/settings/UhidPrefixForm'
import { ProviderProfilesPanel } from '@/components/settings/ProviderProfilesPanel'
import { DepartmentsPanel } from '@/components/settings/DepartmentsPanel'
import { StaffManagementPanel } from '@/components/settings/StaffManagementPanel'
import { Tabs } from '@/components/Tabs'

const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'

export default async function SettingsPage() {
  // Must be the first statement — see the comment in patients/page.tsx.
  const session = await requireSessionOrRedirect()
  // Settings is practice configuration (payers, providers, staff accounts,
  // auto-classify behavior) -- restricted to admin and the PI, no other
  // role, per explicit product direction.
  if (!['admin', 'pi'].includes(session.role)) redirect('/')
  const settings = await getSettingsSummary()
  const providers = await listAllProviders()
  const staff = await listAllUsers()
  const departments = await listDepartments()
  const isAdmin = session.role === 'admin'
  // Own account resolved from the session (users.id, or app settings for the
  // env admin) -- shared with /account (Wave B P1-01 / P2-10).
  const account = await getOwnAccount(session)

  const practiceTab = (
    <section className={SECTION}>
      <PracticeInfoForm initial={{ practiceName: settings.practiceName, practiceSite: settings.practiceSite, practiceTimezone: settings.practiceTimezone }} isAdmin={isAdmin} />
      <div className="mt-5 border-t border-border pt-5">
        <UhidPrefixForm initialPrefix={settings.uhidPrefix} isAdmin={isAdmin} />
      </div>
    </section>
  )

  const classificationTab = (
    <section className={SECTION}>
      <AutoClassifyToggle initialEnabled={settings.autoClassifyOnComplete} isAdmin={isAdmin} />
    </section>
  )

  const queueDisplayTab = (
    <section className={SECTION}>
      <QueueDisplayPinForm isAdmin={isAdmin} configured={settings.queueDisplayPinConfigured} />
    </section>
  )

  const providersTab = (
    <section className={SECTION}>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Provider roster</h2>
      <ProviderProfilesPanel providers={providers} departments={departments} isAdmin={isAdmin} />
    </section>
  )

  const departmentsTab = (
    <section className={SECTION}>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Departments</h2>
      <DepartmentsPanel departments={departments} isAdmin={isAdmin} />
    </section>
  )

  const staffTab = (
    <section className={SECTION}>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Staff accounts</h2>
      <StaffManagementPanel staff={staff} isAdmin={isAdmin} />
    </section>
  )

  const accountTab = <AccountPanel name={session.name} role={session.role} account={account} />

  return (
    <div className="max-w-xl">
      <h1 className="mb-6 text-2xl font-bold text-foreground">Settings</h1>
      <Tabs tabs={[
        { id: 'practice', label: <><Building2 className="h-4 w-4" aria-hidden="true" />Practice</>, content: practiceTab },
        { id: 'classification', label: <><SlidersHorizontal className="h-4 w-4" aria-hidden="true" />Classification</>, content: classificationTab },
        { id: 'queue-display', label: <><Monitor className="h-4 w-4" aria-hidden="true" />Queue Display</>, content: queueDisplayTab },
        { id: 'providers', label: <><Users className="h-4 w-4" aria-hidden="true" />Providers</>, content: providersTab },
        { id: 'departments', label: <><Building className="h-4 w-4" aria-hidden="true" />Departments</>, content: departmentsTab },
        { id: 'staff', label: <><IdCard className="h-4 w-4" aria-hidden="true" />Staff</>, content: staffTab },
        { id: 'account', label: <><UserCircle2 className="h-4 w-4" aria-hidden="true" />Account</>, content: accountTab },
      ]} />
    </div>
  )
}
