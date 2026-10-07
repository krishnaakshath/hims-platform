/** Marks a simulated feature that is only shown when DEMO_FEATURES is on
 *  (src/lib/demo-features.ts). Plain text, so screen readers announce it. */
export function DemoBadge({ className = '' }: { className?: string }) {
  return (
    <span className={`ms-2 inline-flex shrink-0 items-center rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-warning ${className}`}>
      Demo
    </span>
  )
}
