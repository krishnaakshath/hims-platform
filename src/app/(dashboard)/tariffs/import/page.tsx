import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { TARIFF_MANAGE_ROLES } from '@/lib/role-policy'
import { TariffImportForm } from '@/components/tariff/TariffImportForm'

export default async function TariffImportPage() {
  const session = await requireSessionOrRedirect()
  if (!TARIFF_MANAGE_ROLES.includes(session.role)) redirect('/')

  return (
    <div className="space-y-6">
      <div>
        <Link href="/tariffs" className="text-sm text-primary underline-offset-2 hover:underline">Back to tariffs</Link>
        <h1 className="mt-2 text-2xl font-bold text-foreground">Import tariffs from CSV</h1>
        <p className="text-sm text-muted-foreground">Validate first. Commit is only available after a clean check.</p>
      </div>
      <TariffImportForm />
    </div>
  )
}
