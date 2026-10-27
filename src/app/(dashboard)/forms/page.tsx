import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { listFormTemplates } from '@/lib/queries/form-templates'
import { listFormTemplateFolders, countArchivedTemplates } from '@/lib/queries/form-template-folders'
import { FormTemplateCard } from '@/components/FormTemplateCard'
import { FolderCard } from '@/components/FolderCard'
import { EmptyState } from '@/components/ui/empty-state' // WS7 T16
import { CreateFormButton } from '@/components/CreateFormButton'
import { NewFolderButton } from '@/components/NewFolderButton'
import { InstallHospitalPackButton } from '@/components/InstallHospitalPackButton' // WS7 T4
import { HOSPITAL_FORM_PACK } from '@/db/seed-hospital-forms' // WS7 T4

export default async function FormsPage() {
  const session = await requireSessionOrRedirect()
  if (!CLINICAL_ROLES.includes(session.role)) redirect('/')

  const [templates, folders, archivedCount] = await Promise.all([
    listFormTemplates(),
    listFormTemplateFolders(),
    countArchivedTemplates(),
  ])
  await logAudit(session, 'viewed form templates', null)

  const unfoldered = templates.filter((t) => t.folderId === null && t.isActive === true)
  const isEmpty = folders.length === 0 && unfoldered.length === 0
  // WS7 T4: a pack form counts as present by name, archived or not (the install skips it either way).
  const templateNames = new Set(templates.map((t) => t.name))
  const missingPackForms = HOSPITAL_FORM_PACK.filter((f) => !templateNames.has(f.name)).length

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Questionnaires</h1>
        {archivedCount > 0 && (
          <Link href="/forms/archived" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
            {archivedCount} archived
          </Link>
        )}
      </div>
      {session.role === 'admin' && missingPackForms > 0 && <InstallHospitalPackButton missing={missingPackForms} />}
      {isEmpty && <div className="mb-4"><EmptyState title="No form templates yet" description="Create a form, or install the hospital form pack, to send forms to patients." /></div>}
      <div className="grid grid-cols-3 gap-4">
        {folders.map((folder) => (
          <FolderCard key={folder.id} folder={folder} />
        ))}
        {unfoldered.map((t) => (
          <FormTemplateCard key={t.id} template={t} />
        ))}
        <CreateFormButton folderId={null} />
        <NewFolderButton />
      </div>
    </div>
  )
}
