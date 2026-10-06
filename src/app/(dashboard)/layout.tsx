import { getSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { TopBanner } from '@/components/TopBanner'
import { LeftNav } from '@/components/LeftNav'
import { SessionTimeoutWarning } from '@/components/SessionTimeoutWarning'
import { getNavBadges } from '@/lib/nav-badges'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login')
  const badges = await getNavBadges(session)

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
        <LeftNav role={session.role} badges={badges} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  )
}
