// WS6 T11: the collector's "Open in Maps" link.
import { describe, it, expect } from 'vitest'
import { mapsUrl } from '@/lib/home-collection/maps'

describe('mapsUrl', () => {
  it('encodes the address, landmark and PIN into one Google Maps search query', () => {
    const url = mapsUrl({ addressLine1: '12 MG Road', addressLine2: 'Flat 4B', landmark: 'Opp. Shiva Temple & Park', city: 'Pune', pinCode: '411001' })
    expect(url.startsWith('https://www.google.com/maps/search/?api=1&query=')).toBe(true)
    const query = new URL(url).searchParams.get('query')
    expect(query).toBe('12 MG Road, Flat 4B, near Opp. Shiva Temple & Park, Pune 411001')
    expect(url).toContain('411001')
    expect(url).toContain(encodeURIComponent('Opp. Shiva Temple & Park'))
    expect(url).not.toMatch(/[ &]Park/)
  })

  it('skips empty optional parts', () => {
    expect(new URL(mapsUrl({ addressLine1: '7 Main St', addressLine2: null, landmark: '  ', city: 'Mysuru', pinCode: '570001' })).searchParams.get('query'))
      .toBe('7 Main St, Mysuru 570001')
  })
})
