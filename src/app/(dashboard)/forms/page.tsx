import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { listFormTemplates } from '@/lib/queries/form-templates'
import { listFormTemplateFolders, countArchivedTemplates } from '@/lib/queries/form-template-folders'
import { FormTemplateCard } from '@/components/FormTemplateCard'
import { FolderCard } from '@/components/FolderCard'
import { CreateFormButton } from '@/components/CreateFormButton'
import { NewFolderButton } from '@/components/NewFolderButton'

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
      {isEmpty && <p className="mb-4 text-sm text-muted-foreground">No form templates yet.</p>}
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
