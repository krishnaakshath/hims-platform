import { ImageResponse } from 'next/og'
import { brand } from '@/lib/brand'
import { brandIconDataUri, brandIconPalette } from '@/lib/brand-icon'

// Apple touch icon: 180x180, fully opaque and full-bleed (iOS applies its own
// rounded mask and would fill transparency with black), glyph scaled down so
// it sits centred with generous padding inside the mask.

export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
  const palette = brandIconPalette({ primaryColor: brand.primaryColor })
  return new ImageResponse(
    // eslint-disable-next-line jsx-a11y/alt-text
    <img src={brandIconDataUri(palette, { shape: 'square', glyphScale: 0.82 })} width={180} height={180} />,
    { ...size }
  )
}
