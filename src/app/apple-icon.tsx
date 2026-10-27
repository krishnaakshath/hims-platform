import { ImageResponse } from 'next/og'
import { connection } from 'next/server'
import { brandIconDataUri, brandIconPalette } from '@/lib/brand-icon'
import { getBrand, readStoredBrandPng } from '@/lib/brand-server'

// Dynamic on purpose: the brand lives in the database (Settings > Branding), so this metadata route must render per request, never at build time.

// Apple touch icon: 180x180. The hospital's stored icon_180 PNG when there is one; otherwise the
// built-in mark, fully opaque and full-bleed (iOS applies its own rounded mask and would fill
// transparency with black), glyph scaled down so it sits centred with generous padding inside
// the mask. A stored-asset read failure falls back to the render.

export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

const STORED_HEADERS = { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' }

export default async function AppleIcon() {
  await connection()
  const b = await getBrand()
  const stored = await readStoredBrandPng('icon_180')
  if (stored) {
    return new Response(Buffer.from(stored), { headers: STORED_HEADERS })
  }
  const palette = brandIconPalette({ primaryColor: b.accent?.input ?? null })
  return new ImageResponse(
    // eslint-disable-next-line jsx-a11y/alt-text
    <img src={brandIconDataUri(palette, { shape: 'square', glyphScale: 0.82 })} width={180} height={180} />,
    { ...size }
  )
}
