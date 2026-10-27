'use client'
import { createContext, useContext, useState, useCallback, useId, type ReactNode } from 'react'
import Link from 'next/link'
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from 'lucide-react'

export type ToastTone = 'info' | 'success' | 'warning' | 'danger' | 'error'

export interface ToastInput {
  title: string
  description?: string
  tone?: ToastTone
  action?: { label: string; href: string }
  // WS6 T8: an optional second next-step link, shown after `action`.
  secondaryAction?: { label: string; href: string }
}

interface ToastItem extends ToastInput {
  id: string
}

interface ToastContextValue {
  showToast: (toast: ToastInput) => void
  show: (toast: ToastInput) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const TONE_STYLES: Record<ToastTone, { border: string; icon: typeof CheckCircle2; iconClass: string }> = {
  info: { border: 'border-border', icon: Info, iconClass: 'text-primary' },
  success: { border: 'border-emerald-300 dark:border-emerald-700', icon: CheckCircle2, iconClass: 'text-emerald-600 dark:text-emerald-400' },
  warning: { border: 'border-amber-300 dark:border-amber-700', icon: AlertTriangle, iconClass: 'text-amber-600 dark:text-amber-400' },
  danger: { border: 'border-destructive/40', icon: AlertCircle, iconClass: 'text-destructive' },
  error: { border: 'border-destructive/40', icon: AlertCircle, iconClass: 'text-destructive' },
}

function ToastView({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const style = TONE_STYLES[toast.tone ?? 'info']
  const Icon = style.icon
  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-card p-3 shadow-lg ${style.border} text-xs text-foreground`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.iconClass}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{toast.title}</p>
        {toast.description ? <p className="mt-0.5 text-muted-foreground">{toast.description}</p> : null}
        {toast.action || toast.secondaryAction ? (
          <div className="mt-1 flex flex-wrap gap-x-4">
            {[toast.action, toast.secondaryAction].map((a) => a ? (
              <Link
                key={a.label}
                href={a.href}
                className="inline-block font-medium text-primary underline-offset-4 hover:underline"
              >
                {a.label}
              </Link>
            ) : null)}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const showToast = useCallback((input: ToastInput) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setToasts((cur) => [...cur, { ...input, id }])
    setTimeout(() => {
      setToasts((cur) => cur.filter((t) => t.id !== id))
    }, 6000)
  }, [])

  const dismiss = useCallback((id: string) => {
    setToasts((cur) => cur.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ showToast, show: showToast }}>
      {children}
      <div
        aria-label="Notifications"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
      >
        {toasts.map((t) => (
          <ToastView key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    return {
      showToast: () => {},
      show: () => {},
    }
  }
  return ctx
}
