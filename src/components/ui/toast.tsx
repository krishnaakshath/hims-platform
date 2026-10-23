'use client'

import * as React from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import { cn } from 'cn'

export type ToastTone = 'success' | 'error' | 'info'

export interface ToastInput {
  title: string
  description?: string
  tone?: ToastTone
  action?: { label: string; href: string }
}

interface ToastItem extends ToastInput {
  id: number
}

interface ToastContextValue {
  show: (t: ToastInput) => void
}

const ToastContext = React.createContext<ToastContextValue | null>(null)

const MAX_TOASTS = 3
const TOAST_DURATION_MS = 6000

const toneClasses: Record<ToastTone, string> = {
  success: 'border-border border-l-4 border-l-primary',
  error: 'border-destructive/40 border-l-4 border-l-destructive',
  info: 'border-border border-l-4 border-l-muted-foreground',
}

function ToastView({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const tone = toast.tone ?? 'success'
  React.useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), TOAST_DURATION_MS)
    return () => clearTimeout(timer)
  }, [toast.id, onDismiss])

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto flex items-start gap-3 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-md',
        toneClasses[tone],
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">{toast.title}</p>
        {toast.description ? <p className="mt-0.5 text-muted-foreground">{toast.description}</p> : null}
        {toast.action ? (
          <Link
            href={toast.action.href}
            className="mt-1 inline-block font-medium text-primary underline-offset-4 hover:underline"
          >
            {toast.action.label}
          </Link>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismiss(toast.id)}
        className="rounded-md p-1 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  )
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([])
  const nextId = React.useRef(0)

  const dismiss = React.useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const show = React.useCallback((t: ToastInput) => {
    const id = ++nextId.current
    setToasts((prev) => [...prev, { ...t, id }].slice(-MAX_TOASTS))
  }, [])

  const value = React.useMemo(() => ({ show }), [show])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <ToastView key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}
