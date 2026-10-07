'use client'
import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

export function CopyUhidButton({ uhid }: { uhid: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(uhid)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }
  return (
    <button type="button" onClick={copy} aria-label={copied ? 'UHID copied' : 'Copy UHID'}
      className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      <span role="status" className="sr-only">{copied ? 'UHID copied' : ''}</span>
    </button>
  )
}
