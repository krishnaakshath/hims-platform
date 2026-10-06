'use client'
import { useSyncExternalStore } from 'react'

const subscribeNoop = () => () => {}

/**
 * Renders a timestamp in the viewer's own locale/timezone. The server cannot know
 * those, so the text is empty during SSR and hydration (identical on both sides)
 * and filled in after mount, which avoids a hydration mismatch.
 */
export function LocalDateTime({ iso, className }: { iso: string; className?: string }) {
  const hydrated = useSyncExternalStore(subscribeNoop, () => true, () => false)
  let text = ''
  if (hydrated) {
    const d = new Date(iso)
    text = Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
  }
  return <time dateTime={iso} className={className}>{text}</time>
}
