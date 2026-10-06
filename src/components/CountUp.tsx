'use client'
import { useEffect, useRef, useState } from 'react'

// Hand-written (the react-bits registry was timing out repeatedly) -- same
// spirit as react-bits' CountUp, no new dependency. Ease-out cubic so it
// settles rather than stopping abruptly.
//
// The first render is the real value, not 0 (Task 17): the old mount-time
// 0 -> `to` animation meant the server HTML said 0 and anything reading the
// page before ~800ms of animation frames had run -- a background tab (rAF is
// paused there), a screenshot, a screen reader, a quick glance -- saw a
// wrong number (66 patients read as 30, 3 booking requests read as 1). A
// count on a clinical dashboard must be correct whenever it is read, so we
// only animate a *change* of the target (e.g. after a router.refresh()
// following a write), from the previously shown value to the new one.
export function CountUp({ to, duration = 800, className }: { to: number; duration?: number; className?: string }) {
  const [value, setValue] = useState(to)
  const shownRef = useRef(to)

  useEffect(() => {
    const from = shownRef.current
    if (from === to) return
    let startedAt: number | null = null
    let frameId: number

    function step(timestamp: number) {
      if (startedAt === null) startedAt = timestamp
      const progress = duration > 0 ? Math.min((timestamp - startedAt) / duration, 1) : 1
      const eased = 1 - Math.pow(1 - progress, 3)
      const next = Math.round(from + (to - from) * eased)
      shownRef.current = next
      setValue(next)
      if (progress < 1) frameId = requestAnimationFrame(step)
    }
    frameId = requestAnimationFrame(step)
    // If `to` changes again mid-animation, the next run starts from the
    // number currently shown (shownRef), so there is no jump.
    return () => cancelAnimationFrame(frameId)
  }, [to, duration])

  return <span className={className}>{value}</span>
}
