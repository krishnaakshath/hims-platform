import { StaffLoginForm } from '@/components/StaffLoginForm'

// The one door every member of staff (doctors first) walks through: email
// and password straight away, no portal to pick first. The role -- and so the
// workspace that opens -- is resolved from the credentials server-side in
// POST /api/login. Each /login/[role] URL still exists (bookmarkable, same
// form, its own heading) and is reachable from the quiet "All portals" menu
// in the header, alongside the Patient Portal.
export default function LoginPage() {
  return <StaffLoginForm />
}
