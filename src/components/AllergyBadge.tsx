const SEVERITY_DOT: Record<string, string> = {
  severe: 'bg-red-600',
  moderate: 'bg-amber-500',
  mild: 'bg-muted-foreground',
}

export function AllergyBadge({ allergen, reaction, severity }: { allergen: string; reaction: string | null; severity: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`h-2 w-2 rounded-full ${SEVERITY_DOT[severity]}`} aria-hidden="true" />
      <span className="font-medium text-foreground">{allergen}</span>
      {reaction && <span className="text-muted-foreground">— {reaction}</span>}
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{severity}</span>
    </div>
  )
}
