import Link from 'next/link'

export function FormTemplateCard({ template }: { template: { id: number; name: string; diagnosisTag: string; questions: unknown[]; isActive: boolean } }) {
  return (
    <Link href={`/forms/${template.id}`} className="group block rounded-xl border border-primary/10 border-l-2 border-l-transparent bg-card/80 p-5 shadow-sm backdrop-blur-sm transition-all duration-200 hover:border-l-primary hover:bg-primary/5 hover:shadow-md">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-foreground group-hover:text-primary">{template.name}</span>
        {!template.isActive && <span className="text-xs font-medium text-muted-foreground">Inactive</span>}
      </div>
      <p className="text-sm text-muted-foreground">{template.diagnosisTag}</p>
      <p className="mt-2 text-xs text-muted-foreground">{template.questions.length} question{template.questions.length === 1 ? '' : 's'}</p>
    </Link>
  )
}
