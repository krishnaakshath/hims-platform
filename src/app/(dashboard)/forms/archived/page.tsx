import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { listArchivedTemplates } from '@/lib/queries/form-template-folders'
import { RestoreTemplateButton } from '@/components/RestoreTemplateButton'
import { BackLink } from '@/components/BackLink'

export default async function ArchivedFormTemplatesPage() {
  const session = await requireSessionOrRedirect()
  if (!CLINICAL_ROLES.includes(session.role)) redirect('/')

  const templates = await listArchivedTemplates()
  await logAudit(session, 'viewed archived form templates', null)

  return (
    <div>
      <div className="mb-6 space-y-3">
        <BackLink href="/forms" label="Back to Questionnaires" />
        <h1 className="text-2xl font-bold text-foreground">Archived Forms</h1>
      </div>
      {templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No archived forms.</p>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => (
            <div key={t.id} className="flex items-center justify-between rounded-lg border border-primary/10 bg-card/80 p-4 shadow-sm backdrop-blur-sm">
              <div>
                <p className="font-semibold text-foreground">{t.name}</p>
                <p className="text-sm text-muted-foreground">{t.diagnosisTag}</p>
              </div>
              <RestoreTemplateButton templateId={t.id} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
