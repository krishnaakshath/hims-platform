// /coding/code-systems: loaded code-system versions and the small-file web importer (admin only,
// CODE_SYSTEM_ADMIN_ROLES; LeftNav shows it to the same roles). Full releases are loaded with the
// CLI (`npm run codes:import`, docs/CODE-SYSTEMS.md). No code-set content ships with the app.
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CODE_SYSTEM_ADMIN_ROLES } from '@/lib/role-policy'
import { formatDateTimeIn } from '@/lib/india-time'
import { listCodeSystems } from '@/lib/queries/code-systems'
import { CodeSystemList, type CodeSystemView } from '@/components/coding/CodeSystemList'
import { CodeSystemImportForm } from '@/components/coding/CodeSystemImportForm'

export default async function CodeSystemsPage() {
  const session = await requireSessionOrRedirect()
  if (!CODE_SYSTEM_ADMIN_ROLES.includes(session.role)) redirect('/')

  const systems: CodeSystemView[] = (await listCodeSystems()).map((s) => ({
    id: s.id,
    kind: s.kind,
    version: s.version,
    name: s.name,
    isSample: s.isSample,
    isCurrent: s.isCurrent,
    codeCount: s.codeCount,
    licenceNote: s.licenceNote,
    importedByName: s.importedByName,
    importedAtLabel: formatDateTimeIn(s.importedAt),
  }))

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Code systems</h1>
        <p className="text-sm text-muted-foreground">
          Versions of ICD-10, ICD-10-PCS, SNOMED CT, LOINC and PM-JAY HBP loaded for clinical coding. Coders search the current version of each.
        </p>
      </div>

      <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
        <p className="font-medium">Load full releases from the command line</p>
        <p className="mt-1 text-muted-foreground">
          The app ships no code-set content. Obtain each set under its licence, convert it to the CSV format, and load it with{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">npm run codes:import</code>. The steps for each code set are in{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">docs/CODE-SYSTEMS.md</code>. The form below takes files up to 4 MB.
        </p>
      </div>

      <CodeSystemList systems={systems} />

      <section aria-labelledby="cs-import" className="space-y-3">
        <h2 id="cs-import" className="text-lg font-semibold">Load a small code set</h2>
        <CodeSystemImportForm />
      </section>
    </div>
  )
}
