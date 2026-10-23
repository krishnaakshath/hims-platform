// WS6 T11: an "Open in Maps" link for a home-collection visit address. Pure and client-safe: the
// link is a plain Google Maps search URL the collector's phone opens; the app makes no map request.

export interface MapsAddress {
  addressLine1: string
  addressLine2?: string | null
  landmark?: string | null
  city: string
  pinCode: string
}

/** `https://www.google.com/maps/search/?api=1&query=<line 1, line 2, near landmark, city PIN>` (encoded). */
export function mapsUrl(a: MapsAddress): string {
  const landmark = a.landmark?.trim()
  const parts = [a.addressLine1, a.addressLine2, landmark ? `near ${landmark}` : null, `${a.city} ${a.pinCode}`]
    .map((p) => (p ?? '').trim())
    .filter((p) => p !== '')
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(', '))}`
}
