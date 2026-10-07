import { notFound, redirect } from 'next/navigation'
import { parseId } from '@/lib/http'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { getFormTemplateFolder, listActiveTemplatesInFolder } from '@/lib/queries/form-template-folders'
import { FormTemplateCard } from '@/components/FormTemplateCard'
import { CreateFormButton } from '@/components/CreateFormButton'
import { FolderActions } from '@/components/FolderActions'
import { BackLink } from '@/components/BackLink'

export default async function FormTemplateFolderPage({ params }: { params: Promise<{ folderId: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!CLINICAL_ROLES.includes(session.role)) redirect('/')

  const { folderId } = await params
  const id = parseId(folderId)
  if (id === null) notFound()
  const folder = await getFormTemplateFolder(id)
  if (!folder) notFound()

  const templates = await listActiveTemplatesInFolder(folder.id)
  await logAudit(session, `viewed form template folder ${folderId}`, null)

  return (
    <div>
      <div className="mb-6 space-y-3">
        <BackLink href="/forms" label="Back to Questionnaires" />
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">{folder.name}</h1>
          <FolderActions folder={{ id: folder.id, name: folder.name }} templateCount={templates.length} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4">
        {templates.map((t) => (
          <FormTemplateCard key={t.id} template={t} />
        ))}
        <CreateFormButton folderId={folder.id} />
      </div>
    </div>
  )
}
