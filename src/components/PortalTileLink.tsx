'use client'
import { useRef, useState } from 'react'
import Link from 'next/link'

// Adapted from the react-bits SpotlightCard pattern (mouse-follow radial
// glow), but rendering an actual <Link> as the interactive root instead of
// SpotlightCard's <div> wrapper -- these tiles need real navigation
// semantics, not a decorative card with a click handler.
export function PortalTileLink({ href, className, spotlightColor = 'rgba(59, 74, 143, 0.12)', children }: {
  href: string
  className?: string
  spotlightColor?: string
  children: React.ReactNode
}) {
  const ref = useRef<HTMLAnchorElement>(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [opacity, setOpacity] = useState(0)

  function handleMouseMove(e: React.MouseEvent<HTMLAnchorElement>) {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    setPosition({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  return (
    <Link
      ref={ref}
      href={href}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setOpacity(1)}
      onMouseLeave={() => setOpacity(0)}
      className={`group relative overflow-hidden ${className ?? ''}`}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 ease-out"
        style={{ opacity, background: `radial-gradient(circle at ${position.x}px ${position.y}px, ${spotlightColor}, transparent 70%)` }}
        aria-hidden="true"
      />
      {children}
    </Link>
  )
}
