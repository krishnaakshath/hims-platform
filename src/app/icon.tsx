import { ImageResponse } from 'next/og'
import { connection } from 'next/server'
import { brandIconDataUri, brandIconPalette, brandIconSvg } from '@/lib/brand-icon'
import { getBrand, readStoredBrandPng } from '@/lib/brand-server'

// Dynamic on purpose: the brand lives in the database (Settings > Branding), so this metadata route must render per request, never at build time.

// The favicon family, served as
//   /icon/32   32x32 PNG  (tab favicon)
//   /icon/192  192x192 PNG (Android / manifest)
//   /icon/512  512x512 PNG (manifest, splash screens)
//   /icon/svg  scalable SVG (browsers that prefer vector favicons)
// A hospital's uploaded icon (stored icon_<n> PNG, derived at upload) wins; /icon/svg then wraps
// the stored 512 PNG in an SVG we build (never a user SVG). Otherwise every size is a
// rasterisation of the built-in "pulse plus" mark (src/lib/brand-icon.ts) on a tile in the brand
// colour, so the sizes never drift. Any stored-asset read failure falls back to the render.

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

/** An SVG document that only embeds our stored PNG as a base64 data URI. */
function pngInSvg(png: Uint8Array): string {
  const b64 = Buffer.from(png).toString('base64')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">` +
    `<image href="data:image/png;base64,${b64}" width="512" height="512"/>` +
    `</svg>`
  )
}

const STORED_HEADERS = { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' }

export default async function Icon({ id }: { id: Promise<string | number> }) {
  await connection()
  const iconId = String(await id)
  const b = await getBrand()
  const palette = brandIconPalette({ primaryColor: b.accent?.input ?? null })

  if (iconId === 'svg') {
    const stored = await readStoredBrandPng('icon_512')
    return new Response(stored ? pngInSvg(stored) : brandIconSvg(palette), {
      headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' },
    })
  }

  const px = ICON_PNG_SIZES.find((s) => String(s) === iconId) ?? 32
  const stored = await readStoredBrandPng(`icon_${px}`)
  if (stored) {
    return new Response(Buffer.from(stored), { headers: STORED_HEADERS })
  }
  return new ImageResponse(
    // eslint-disable-next-line jsx-a11y/alt-text
    <img src={brandIconDataUri(palette)} width={px} height={px} />,
    { width: px, height: px }
  )
}
