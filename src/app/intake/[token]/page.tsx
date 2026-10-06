import { getIntakePortalData } from '@/lib/queries/intake-portal'
import { IntakePortalForm } from '@/components/IntakePortalForm'
import { BrandLogo } from '@/components/BrandLogo'

export default async function IntakePortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const data = await getIntakePortalData(token)

  if (data.state === 'not_found') {
    return <PortalMessage title="Link not found" body="This link doesn't match any form on file. Please check the link or contact the office that sent it to you." />
  }
  if (data.state === 'expired') {
    return <PortalMessage title="This link has expired" body="For your security, intake links expire after 30 days. Please contact the office to request a new one." />
  }
  if (data.state === 'completed') {
    return <PortalMessage title="Already submitted" body="This form has already been completed. If you need to make a change, please contact the office directly." />
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg rounded-xl border border-primary/10 bg-card p-8 shadow-sm">
        <div className="mb-6">
          <BrandLogo className="text-base font-semibold tracking-tight text-foreground" />
        </div>
        <h1 className="mb-1 text-xl font-semibold text-foreground">{data.templateName}</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          {data.questions!.length > 0
            ? 'Please answer the questions below. Fields marked with an asterisk are required.'
            : 'Please read and sign the documents below.'}
        </p>
        <IntakePortalForm token={token} questions={data.questions!} existingAnswers={data.existingAnswers!} autofill={data.autofill!} consents={data.consents ?? []} />
        <p className="mt-6 border-t border-border pt-4 text-xs text-muted-foreground">
          Your answers are sent directly and securely to the office. This page does not store your information anywhere else.
        </p>
      </div>
    </div>
  )
}

function PortalMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-xl border border-primary/10 bg-card p-8 text-center shadow-sm">
        <div className="mb-4 flex flex-col items-center gap-1">
          <BrandLogo className="text-base font-semibold tracking-tight text-foreground" />
        </div>
        <h1 className="mb-2 text-lg font-semibold text-foreground">{title}</h1>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}
