'use client'
import { useBrand } from '@/components/BrandProvider'

// The product wordmark: the configured logo image when BRAND_LOGO_URL is set
// (with the brand name as its alt text), otherwise the brand name as text.
// The name is rendered as a React text node / attribute -- always escaped,
// never HTML.
export function BrandLogo({ className = 'text-lg font-semibold tracking-tight' }: { className?: string }) {
  const { name, logoUrl } = useBrand()
  if (logoUrl) {
    // A plain <img>: the logo URL is per-deployment config (any https host),
    // which next/image would require listing in images.remotePatterns.
    // h-[1.5em] keeps the image scaled to the same text-size classes callers
    // already pass for the text wordmark.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt={name} className={`${className} h-[1.5em] w-auto`} />
  }
  return <span className={className}>{name}</span>
}
