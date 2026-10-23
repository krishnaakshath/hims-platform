'use client'
import { useBrand } from '@/components/BrandProvider'

// The product wordmark: the brand's logo image when one is set (an uploaded
// logo or a configured URL, with the brand name as its alt text), otherwise
// the brand name as text. With a dark-theme logo, the light one shows under
// the light theme and the dark one under `.dark`. The name is rendered as a
// React text node / attribute -- always escaped, never HTML.
export function BrandLogo({ className = 'text-lg font-semibold tracking-tight' }: { className?: string }) {
  const { name, logoUrl, logoDarkUrl } = useBrand()
  if (logoUrl) {
    // A plain <img>: the logo URL is per-deployment config (any https host),
    // which next/image would require listing in images.remotePatterns.
    // h-[1.5em] keeps the image scaled to the same text-size classes callers
    // already pass for the text wordmark.
    const img = `${className} h-[1.5em] w-auto`
    if (!logoDarkUrl) {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={logoUrl} alt={name} className={img} />
    }
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoUrl} alt={name} className={`${img} dark:hidden`} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoDarkUrl} alt={name} className={`${img} hidden dark:inline`} />
      </>
    )
  }
  return <span className={className}>{name}</span>
}
