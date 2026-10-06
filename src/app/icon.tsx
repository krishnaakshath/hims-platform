import { ImageResponse } from 'next/og'

export const size = { width: 32, height: 32 }
export const contentType = 'image/png'

// Replaces the default Next.js favicon with something that matches this
// app's actual identity -- a stethoscope glyph on the same professional
// blue used for the primary brand color throughout the UI (--primary in
// globals.css, oklch(0.42 0.1 250) ~= #194f81), rather than the generic
// Next.js "N" mark or Vercel's triangle. Deliberately not black/near-black
// anywhere in this app, including here.
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#194f81',
          borderRadius: 7,
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.8 2.9v6.2a4.8 4.8 0 0 0 9.6 0V2.9" />
          <path d="M4.8 6.4H2.9" />
          <path d="M14.4 6.4h1.9" />
          <path d="M9.6 15.9v2.4a4.8 4.8 0 0 0 9.6 0v-1.7" />
          <circle cx="19.9" cy="12.5" r="2.1" />
        </svg>
      </div>
    ),
    { ...size }
  )
}
