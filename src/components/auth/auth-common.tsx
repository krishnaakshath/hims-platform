'use client'
import { useEffect, useState } from 'react'
import { useBrand } from '@/components/BrandProvider'
import { DEFAULT_LOGIN_QUOTE, type LoginQuote } from '@/lib/brand'

type MotionState = 'on' | 'paused' | 'reduce'

// 'reduce' when the user asks for reduced motion, 'paused' while the tab is
// hidden (looping decoration stops spending frames), otherwise 'on'. CSS in
// globals.css keys every sign-in animation off this attribute as well as the
// prefers-reduced-motion media query.
export function useMotionState(): MotionState {
  const [state, setState] = useState<MotionState>('on')
  useEffect(() => {
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    const update = () => setState(mq?.matches ? 'reduce' : document.hidden ? 'paused' : 'on')
    update()
    mq?.addEventListener?.('change', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      mq?.removeEventListener?.('change', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  return state
}

export function useLoginQuote(): LoginQuote {
  return useBrand().loginQuote ?? DEFAULT_LOGIN_QUOTE
}

// A long heartbeat trace: `beats` complexes across `width` user units, centred
// on y = 0, flat between beats.
export function pulsePath(width: number, beats: number, amp = 1): string {
  const seg = width / beats
  let d = `M0 0`
  for (let i = 0; i < beats; i++) {
    const x = i * seg + seg * 0.42
    d += ` H${x.toFixed(1)} l${(10 * amp).toFixed(1)} ${(-8 * amp).toFixed(1)} l${(8 * amp).toFixed(1)} ${(8 * amp).toFixed(1)} h${(30 * amp).toFixed(1)}`
    d += ` l${(8 * amp).toFixed(1)} ${(-46 * amp).toFixed(1)} l${(12 * amp).toFixed(1)} ${(84 * amp).toFixed(1)} l${(10 * amp).toFixed(1)} ${(-52 * amp).toFixed(1)}`
    d += ` l${(8 * amp).toFixed(1)} ${(14 * amp).toFixed(1)} h${(22 * amp).toFixed(1)} l${(12 * amp).toFixed(1)} ${(-10 * amp).toFixed(1)} l${(12 * amp).toFixed(1)} ${(10 * amp).toFixed(1)}`
  }
  return d + ` H${width}`
}

/** A static faint trace plus a travelling highlight (.auth-trace). */
export function PulseTrace({ width, beats, y, amp = 1, base, glow, baseOpacity = 0.12, glowOpacity = 0.85, strokeWidth = 2 }: {
  width: number; beats: number; y: number; amp?: number; base: string; glow: string; baseOpacity?: number; glowOpacity?: number; strokeWidth?: number
}) {
  const d = pulsePath(width, beats, amp)
  return (
    <g transform={`translate(0 ${y})`}>
      <path d={d} stroke={base} strokeOpacity={baseOpacity} strokeWidth={strokeWidth * 0.75} strokeLinejoin="round" fill="none" />
      <path className="auth-trace" pathLength={1} d={d} stroke={glow} strokeOpacity={glowOpacity} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </g>
  )
}
