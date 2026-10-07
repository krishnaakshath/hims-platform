import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { ACCOUNT_ROLES } from '@/lib/role-policy'
import { getOwnAccount } from '@/lib/queries/own-account'
import { AccountPanel } from '@/components/account/AccountPanel'

export default async function AccountPage() {
  // Must be the first statement -- see the comment in patients/page.tsx.
  const session = await requireSessionOrRedirect()
  if (!ACCOUNT_ROLES.includes(session.role)) redirect('/')
  const account = await getOwnAccount(session)

  return (
    <div className="max-w-xl">
      <h1 className="mb-6 text-2xl font-bold text-foreground">My Account</h1>
      <AccountPanel name={session.name} role={session.role} account={account} />
    </div>
  )
}
