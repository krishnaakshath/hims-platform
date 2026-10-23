import { getSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { TopBanner } from '@/components/TopBanner'
import { LeftNav } from '@/components/LeftNav'
import { SessionTimeoutWarning } from '@/components/SessionTimeoutWarning'
import { getNavBadges } from '@/lib/nav-badges'
import { demoFeaturesEnabled } from '@/lib/demo-features'
import { trialsEnabled } from '@/lib/features'
import { getBrandOnboarding } from '@/lib/brand-server'
import type { BrandOnboardingStatus } from '@/lib/brand-resolve'
import { BrandOnboardingCard } from '@/components/BrandOnboardingCard'
import { BRAND_SETTINGS_ROLES } from '@/lib/role-policy'
import { ToastProvider } from '@/components/ui/toast'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login')
  const badges = await getNavBadges(session)

  // WL T11: first-run branding checklist, for the roles that may edit branding; any failure renders nothing.
  let onboarding: BrandOnboardingStatus | null = null
  if (BRAND_SETTINGS_ROLES.includes(session.role)) {
    try {
      onboarding = await getBrandOnboarding()
    } catch {
      onboarding = null
    }
  }
  // end WL T11

  return (
    // h-screen + overflow-hidden (not min-h-screen) is deliberate: without a
    // height BOUND on this wrapper, "overflow-auto" below has nothing to
    // scroll within, so a tall page just grows the whole document and the
    // browser scrolls the entire window -- carrying the sidebar and top bar
    // away with it instead of leaving them pinned while only the page
    // content scrolls.
    <div className="flex h-screen flex-col overflow-hidden">
      <SessionTimeoutWarning />
      <TopBanner userName={session.name} role={session.role} />
      {/* min-h-0 for the same reason LeftNav's inner scroll area needs it --
          a flex item's default min-height is its content's natural height,
          not 0, so without this a tall child could grow this row past the
          screen instead of each side scrolling independently within it. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <LeftNav role={session.role} badges={badges} demoFeatures={demoFeaturesEnabled()} trials={trialsEnabled()} />
        <main className="flex-1 overflow-y-auto p-6">
          <ToastProvider>
            {onboarding && !onboarding.complete && !onboarding.dismissed && <BrandOnboardingCard status={onboarding} />}
            {children}
          </ToastProvider>
        </main>
      </div>
    </div>
  )
}
