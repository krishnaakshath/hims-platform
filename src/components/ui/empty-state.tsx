import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { cn } from 'cn'

export interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: string
  action?: { label: string; href?: string; onClick?: () => void }
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      {Icon ? <Icon className="size-8 text-muted-foreground" aria-hidden="true" /> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? (
        action.href ? (
          <Link href={action.href} className={cn(buttonVariants({ variant: 'outline' }), 'mt-2')}>
            {action.label}
          </Link>
        ) : (
          <button type="button" onClick={action.onClick} className={cn(buttonVariants({ variant: 'outline' }), 'mt-2')}>
            {action.label}
          </button>
        )
      ) : null}
    </div>
  )
}
