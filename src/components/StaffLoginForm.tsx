'use client'
import { SignIn } from '@/components/auth/SignIn'

export interface StaffPortal {
  key: string
  label: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  /** Tailwind classes written out literally per-role (not interpolated) so the JIT compiler can see and keep them. */
  iconBg: string
  iconText: string
}

// The staff sign-in page used by /login (no portal) and every /login/[role]
// page (portal = that department, shown as an eyebrow above the heading). The
// password + MFA state machine lives in auth/StaffSignInForm; the portal is
// wayfinding only -- the role a login grants always comes from the
// credentials, resolved server-side in POST /api/login.
export function StaffLoginForm({ portal }: { portal?: StaffPortal }) {
  return <SignIn audience="staff" portal={portal} />
}
