import { redirect } from 'next/navigation'
import { parseId } from '@/lib/http'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { listFormTemplateFolders } from '@/lib/queries/form-template-folders'
import { FormBuilderEditor } from '@/components/FormBuilderEditor'

// "Create New Form" lands here (spec D11). Client state only: the template row
// is created by the editor on the first edit, which then replaces the URL with
// /forms/<id>. Same gate as /forms/[templateId].
export default async function NewFormTemplatePage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  const session = await requireSessionOrRedirect()
  if (!CLINICAL_ROLES.includes(session.role)) redirect('/')

  const sp = (await searchParams) ?? {}
  const requestedFolderId = parseId(typeof sp.folderId === 'string' ? sp.folderId : null)
  const folders = await listFormTemplateFolders()
  // A stale or hand-typed folderId is dropped rather than failing the create later.
  const folderId = folders.some((f) => f.id === requestedFolderId) ? requestedFolderId : null
  await logAudit(session, 'opened new form template editor', null)

  return (
    <FormBuilderEditor
      templateId={null}
      initial={{ name: '', category: '', diagnosisTag: '', questions: [], languages: ['en'], folderId }}
      initialIsActive
      folders={folders.map((f) => ({ id: f.id, name: f.name }))}
      attachedConsents={[]}
      allConsentDocuments={[]}
    />
  )
}
