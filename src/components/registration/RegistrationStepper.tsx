'use client'

// WS6 T8: the progress header of the stepped registration dialog ("Step 2 of 4"
// with a progress bar and the step names). Purely presentational: the dialog
// owns the current step and its validation.
export function RegistrationStepper({ steps, current }: { steps: readonly string[]; current: number }) {
  const label = `Step ${current + 1} of ${steps.length}`
  const percent = Math.round(((current + 1) / steps.length) * 100)
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">{steps[current]}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={1}
        aria-valuemax={steps.length}
        aria-valuenow={current + 1}
        aria-valuetext={`${label}: ${steps[current]}`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <ol className="hidden justify-between gap-2 text-xs sm:flex">
        {steps.map((s, i) => (
          <li key={s} aria-current={i === current ? 'step' : undefined} className={i === current ? 'font-medium text-foreground' : 'text-muted-foreground'}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>
    </div>
  )
}
