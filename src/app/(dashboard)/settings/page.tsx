import { Building, Building2, SlidersHorizontal, UserCircle2, Users, IdCard, Monitor, FlaskConical } from 'lucide-react'
import { eq } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { getDb } from '@/db/client'
import { users } from '@/db/schema'
import { getSettingsSummary, getAdminMfaState } from '@/lib/queries/settings'
import { listAllProviders } from '@/lib/queries/providers'
import { listAllUsers } from '@/lib/queries/users'
import { listDepartments } from '@/lib/queries/departments'
import { ROLE_CAPABILITIES } from '@/lib/role-capabilities'
import { AutoClassifyToggle } from '@/components/AutoClassifyToggle'
import { QueueDisplayPinForm } from '@/components/QueueDisplayPinForm'
import { PracticeInfoForm } from '@/components/PracticeInfoForm'
import { UhidPrefixForm } from '@/components/settings/UhidPrefixForm'
import { ProviderProfilesPanel } from '@/components/settings/ProviderProfilesPanel'
import { DepartmentsPanel } from '@/components/settings/DepartmentsPanel'
import { StaffManagementPanel } from '@/components/settings/StaffManagementPanel'
import { StaffMfaSelfResetForm } from '@/components/settings/StaffMfaSelfResetForm'
import { MfaMethodPicker } from '@/components/settings/MfaMethodPicker'
import { Tabs } from '@/components/Tabs'
// SP5 lab setup
import { listCollectionWindows, listLabTestsWithSetup, listServiceAreaPins } from '@/lib/queries/lab-setup'
import { listServices } from '@/lib/queries/tariff'
import { LAB_SETUP_ROLES } from '@/lib/role-policy'
import { LabServiceAreaPanel } from '@/components/settings/LabServiceAreaPanel'
import { HomeCollectionWindowsPanel } from '@/components/settings/HomeCollectionWindowsPanel'
import { LabTestSetupPanel } from '@/components/settings/LabTestSetupPanel'
// end SP5

const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'

const ROLE_LABEL: Record<string, string> = { admin: 'Administrator', pi: 'Principal Investigator', crc: 'Clinical Research Coordinator', frontdesk: 'Front Desk / Reception', pharmacy: 'Pharmacy' }

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
  const capabilities = ROLE_CAPABILITIES[session.role]
  // SP5 lab setup: everyone on this page reads it; only LAB_SETUP_ROLES (admin) edit.
  const [servicePins, collectionWindows, labTestSetup, labServices, imagingServices] = await Promise.all([
    listServiceAreaPins(),
    listCollectionWindows(),
    listLabTestsWithSetup(),
    listServices({ category: 'investigation_lab', limit: 500 }),
    listServices({ category: 'investigation_imaging', limit: 500 }),
  ])
  const canEditLabSetup = LAB_SETUP_ROLES.includes(session.role)
  const investigationServices = [...labServices, ...imagingServices].map((s) => ({ id: s.id, code: s.code, name: s.name }))
  // end SP5
  const currentUserEmail = session.role === 'admin' ? (process.env.ADMIN_EMAIL ?? '') : (staff.find((s) => s.name === session.name && s.role === session.role)?.email ?? '')

  // Same resolution as PUT /api/account/mfa-method: admin's MFA state lives
  // on appSettings, everyone else's on their own users row (matched by
  // name+role, since session.name is a display name, not an email).
  let currentMfaMethod: 'totp' | 'sms' | 'email' = 'totp'
  let currentPhone: string | null = null
  if (session.role === 'admin') {
    const adminMfa = await getAdminMfaState()
    currentMfaMethod = adminMfa.mfaMethod
    currentPhone = adminMfa.phone
  } else {
    const [row] = await getDb().select().from(users).where(eq(users.name, session.name))
    if (row && row.role === session.role) {
      currentMfaMethod = row.mfaMethod
      currentPhone = row.phone
    }
  }

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

  // SP5
  const labSetupTab = (
    <div className="space-y-4">
      <section className={SECTION}>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Home collection service area</h2>
        <LabServiceAreaPanel pins={servicePins} isAdmin={canEditLabSetup} />
      </section>
      <section className={SECTION}>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Collection windows</h2>
        <HomeCollectionWindowsPanel windows={collectionWindows} isAdmin={canEditLabSetup} />
      </section>
      <section className={SECTION}>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lab tests: sample and tariff</h2>
        <LabTestSetupPanel tests={labTestSetup} services={investigationServices} isAdmin={canEditLabSetup} />
      </section>
    </div>
  )
  // end SP5

  const accountTab = (
    <div className="space-y-4">
      <section className={SECTION}>
        <div className="flex items-center gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
            <UserCircle2 className="h-6 w-6" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">{session.name}</p>
            <p className="text-xs text-muted-foreground">{ROLE_LABEL[session.role] ?? session.role}</p>
          </div>
        </div>
      </section>
      <section className={SECTION}>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">What you can do</h2>
        <p className="mb-3 text-sm text-foreground">{capabilities.summary}</p>
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          {capabilities.bullets.map((b, i) => <li key={i}>• {b}</li>)}
        </ul>
      </section>
      <section className={SECTION}>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Security</h2>
        <p className="mb-3 text-sm text-muted-foreground">Two-factor authentication is required for every staff account. If you&apos;ve lost your device, reset it here and set it up again on your next sign-in.</p>
        <div className="space-y-3">
          <MfaMethodPicker email={currentUserEmail} currentMethod={currentMfaMethod} currentPhone={currentPhone} />
          <StaffMfaSelfResetForm email={currentUserEmail} />
        </div>
      </section>
    </div>
  )

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
        { id: 'lab-setup', label: <><FlaskConical className="h-4 w-4" aria-hidden="true" />Lab setup</>, content: labSetupTab }, // SP5
        { id: 'account', label: <><UserCircle2 className="h-4 w-4" aria-hidden="true" />Account</>, content: accountTab },
      ]} />
    </div>
  )
}
