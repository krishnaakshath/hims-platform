import { notFound, redirect } from 'next/navigation'
import { parseId } from '@/lib/http'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { getFormTemplate } from '@/lib/queries/form-templates'
import { listFormTemplateFolders } from '@/lib/queries/form-template-folders'
import { listConsentsForTemplate } from '@/lib/queries/form-template-consents'
import { listConsentDocuments } from '@/lib/queries/consent-documents'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { FormBuilderEditor } from '@/components/FormBuilderEditor'

export default async function FormTemplateDetailPage({ params }: { params: Promise<{ templateId: string }> }) {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:50 — the Form Templates entry is rendered for admin/crc/pi.
  // Must precede notFound() below, not follow it. (This was previously
  // admin/crc only, stale against LeftNav and against forms/page.tsx's own
  // gate -- a pi could see "Form Templates" in nav and the list page, but
  // got redirected home the moment they opened one.)
  if (!CLINICAL_ROLES.includes(session.role)) redirect('/')
  const { templateId } = await params
  const numericId = parseId(templateId)
  if (numericId === null) notFound()
  const template = await getFormTemplate(numericId)
  if (!template) notFound()
  const [folders, attachedConsents, consentDocuments, patients] = await Promise.all([
    listFormTemplateFolders(),
    listConsentsForTemplate(template.id),
    listConsentDocuments(),
    listPatientsWithStatus(null),
  ])
  await logAudit(session, `viewed form template ${templateId}`, null)

  return (
    <FormBuilderEditor
      templateId={template.id}
      initialName={template.name}
      initialCategory={template.category}
      initialDiagnosisTag={template.diagnosisTag}
      initialQuestions={template.questions}
      initialFolderId={template.folderId}
      initialIsActive={template.isActive}
      folders={folders.map((f) => ({ id: f.id, name: f.name }))}
      attachedConsents={attachedConsents}
      allConsentDocuments={consentDocuments.map((d) => ({ id: d.id, name: d.name }))}
      // Project to what SendFormModal's prop type requires; never ship full patient rows to the client.
      patients={patients.map(({ id, name }) => ({ id, name }))}
    />
  )
}
