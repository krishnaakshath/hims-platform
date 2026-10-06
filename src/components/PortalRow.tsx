import Link from 'next/link'
import { ChevronRight } from 'lucide-react'

// A single row in the portal picker list -- text only, no icon badge. See
// src/app/login/page.tsx for why: this is a daily-use door, not a landing
// page, so it reads as plain enterprise software (an account/workspace
// picker), not a product marketing surface.
export function PortalRow({
  href,
  label,
  description,
  className = '',
}: {
  href: string
  label: string
  description: string
  className?: string
}) {
  return (
    <Link
      href={href}
      className={`group flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-secondary ${className}`}
    >
      <span>
        <span className="block text-sm font-semibold text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
    </Link>
  )
}
