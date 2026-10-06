import { BrandLogo } from '@/components/BrandLogo'
import { STAFF_PORTALS } from '@/lib/staff-portals'
import { PortalRow } from '@/components/PortalRow'

// Picking a row navigates to that role's own /login/[role] URL (a real,
// separate, shareable/bookmarkable page) -- it never grants a role itself.
// The real role always comes from the credentials, resolved server-side in
// POST /api/login, which every /login/[role] page calls identically via the
// shared StaffLoginForm.
//
// Deliberately a plain list, not a grid of colored icon tiles -- this is the
// door staff (including physicians) walk through every single workday, not
// a marketing surface. No per-role icon badge, no animated background: just
// the role name, what it's for, and a chevron. Same pattern as any
// enterprise workspace/account picker (Hex, Langdock).
export default function LoginPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <BrandLogo className="text-xl font-bold tracking-tight text-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">Choose your portal, then sign in with your staff credentials.</p>
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {STAFF_PORTALS.map(({ key, label, description }, i) => (
            <PortalRow
              key={key}
              href={`/login/${key}`}
              label={label}
              description={description}
              className={i > 0 ? 'border-t border-border' : ''}
            />
          ))}
          <PortalRow
            href="/patient-portal/login"
            label="Patient Portal"
            description="Records, forms, and messages"
            className="border-t border-border"
          />
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Every portal is the same secure sign-in — your role is determined by your credentials.
        </p>
      </div>
    </div>
  )
}
