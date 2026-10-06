import { getSessionByToken } from '@/lib/queries/telemedicine-sessions'
import { JoinVideoVisitButton } from '@/components/JoinVideoVisitButton'
import { BrandLogo } from '@/components/BrandLogo'

// This route deliberately lives outside the `(dashboard)` group -- no nav,
// no unrelated app chrome, matching src/app/intake/[token]/page.tsx exactly
// (spec §4: "no other app chrome ... a stripped-down, single-purpose page
// for a person who isn't a portal user"). It is not staff-session-gated: the
// token in the URL is the patient's credential for this one call, same as
// the intake page's token.
export default async function TelemedicineJoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const session = await getSessionByToken(token)

  if (!session || session.status === 'completed' || session.status === 'failed') {
    return <PortalMessage title="This link is no longer valid" body="This video visit link doesn't match an active session. Please contact the office if you believe this is an error." />
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-2xl rounded-xl border border-primary/10 bg-card p-8 shadow-sm">
        <div className="mb-6">
          <BrandLogo className="text-base font-semibold tracking-tight text-foreground" />
        </div>
        <h1 className="mb-1 text-xl font-semibold text-foreground">Video Visit</h1>
        <p className="mb-6 text-sm text-muted-foreground">You&apos;re about to join a video visit with your provider.</p>
        <JoinVideoVisitButton pollUrl={`/api/telemedicine/join/${token}/signal`} initialStatus={session.status} />
      </div>
    </div>
  )
}

function PortalMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-xl border border-primary/10 bg-card p-8 text-center shadow-sm">
        <div className="mb-4 flex flex-col items-center gap-1">
          <BrandLogo className="text-base font-semibold tracking-tight text-foreground" />
        </div>
        <h1 className="mb-2 text-lg font-semibold text-foreground">{title}</h1>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}
