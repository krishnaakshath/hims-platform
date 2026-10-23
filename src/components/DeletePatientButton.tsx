'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MoreHorizontal } from 'lucide-react'
import { ArchivePatientDialog } from '@/components/ArchivePatientDialog'

// WS8 T13 (spec D17): "Delete" became archive. The patient page offers it (admin only) as a
// secondary item inside a "More" menu, not as a red header button.
export function ArchivePatientButton({ patientId, patientName, uhid }: { patientId: string; patientName: string; uhid: string | null }) {
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onPointer = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        More
      </button>
      {menuOpen && (
        <div role="menu" className="absolute right-0 z-20 mt-1 min-w-[10rem] rounded-md border border-border bg-card p-1 shadow-md">
          <button
            type="button"
            role="menuitem"
            onClick={() => { setMenuOpen(false); setDialogOpen(true) }}
            className="w-full rounded px-3 py-1.5 text-left text-sm text-foreground hover:bg-secondary"
          >
            Archive patient
          </button>
        </div>
      )}
      {dialogOpen && (
        <ArchivePatientDialog
          target={{ id: patientId, name: patientName, uhid }}
          onClose={() => setDialogOpen(false)}
          onArchived={() => router.refresh()}
        />
      )}
    </div>
  )
}
