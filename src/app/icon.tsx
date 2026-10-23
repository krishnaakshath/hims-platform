import { ImageResponse } from 'next/og'
import { brand } from '@/lib/brand'
import { brandIconDataUri, brandIconPalette, brandIconSvg } from '@/lib/brand-icon'

// The favicon family: one "pulse plus" mark (see src/lib/brand-icon.ts) on a
// tile filled with the deployment's brand colour, served as
//   /icon/32   32x32 PNG  (tab favicon)
//   /icon/192  192x192 PNG (Android / manifest)
//   /icon/512  512x512 PNG (manifest, splash screens)
//   /icon/svg  scalable SVG (browsers that prefer vector favicons)
// Every PNG is a rasterisation of the same SVG, so the sizes never drift.

export const ICON_PNG_SIZES = [32, 192, 512] as const

export function generateImageMetadata() {
  return [
    ...ICON_PNG_SIZES.map((px) => ({
      id: String(px),
      contentType: 'image/png',
      size: { width: px, height: px },
    })),
    { id: 'svg', contentType: 'image/svg+xml' },
  ]
}

export default async function Icon({ id }: { id: Promise<string | number> }) {
  const iconId = String(await id)
  const palette = brandIconPalette({ primaryColor: brand.primaryColor })

  if (iconId === 'svg') {
    return new Response(brandIconSvg(palette), {
      headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' },
    })
  }

  const px = ICON_PNG_SIZES.find((s) => String(s) === iconId) ?? 32
  return new ImageResponse(
    // eslint-disable-next-line jsx-a11y/alt-text
    <img src={brandIconDataUri(palette)} width={px} height={px} />,
    { width: px, height: px }
  )
}
