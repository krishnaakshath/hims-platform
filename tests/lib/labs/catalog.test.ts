import { describe, it, expect } from 'vitest'
import {
  SAMPLE_TYPES, SAMPLE_TYPE_LABEL, SAMPLE_CONTAINERS, SAMPLE_CONTAINER_LABEL, LAB_QUOTE_STATUSES, MAX_QUOTED_PAISE,
  quoteFromResolution,
} from '@/lib/labs/catalog'

describe('lab catalog', () => {
  it('labels every sample type and container', () => {
    expect(Object.keys(SAMPLE_TYPE_LABEL).sort()).toEqual([...SAMPLE_TYPES].sort())
    expect(Object.keys(SAMPLE_CONTAINER_LABEL).sort()).toEqual([...SAMPLE_CONTAINERS].sort())
    expect(SAMPLE_CONTAINER_LABEL.edta_lavender).toBe('EDTA (lavender cap)')
    expect(LAB_QUOTE_STATUSES).toEqual(['quoted', 'unmapped', 'no_rate', 'service_inactive', 'service_not_found'])
    expect(MAX_QUOTED_PAISE).toBe(1_000_000_000)
  })

  it('maps tariff resolutions to quotes', () => {
    expect(quoteFromResolution(null)).toEqual({ quotedPricePaise: null, quotedTariffRateId: null, quoteStatus: 'unmapped' })
    expect(quoteFromResolution({ ok: true, amountPaise: 45000, rateId: 9 } as never)).toEqual({ quotedPricePaise: 45000, quotedTariffRateId: 9, quoteStatus: 'quoted' })
    expect(quoteFromResolution({ ok: true, amountPaise: 1_000_000_000, rateId: 9 } as never).quoteStatus).toBe('quoted')
    expect(quoteFromResolution({ ok: true, amountPaise: 1_000_000_001, rateId: 9 } as never)).toEqual({ quotedPricePaise: null, quotedTariffRateId: null, quoteStatus: 'no_rate' })
    expect(quoteFromResolution({ ok: false, reason: 'service_inactive' }).quoteStatus).toBe('service_inactive')
    expect(quoteFromResolution({ ok: false, reason: 'service_not_found' }).quoteStatus).toBe('service_not_found')
    expect(quoteFromResolution({ ok: false, reason: 'no_rate' }).quoteStatus).toBe('no_rate')
    expect(quoteFromResolution({ ok: false, reason: 'invalid_date' })).toEqual({ quotedPricePaise: null, quotedTariffRateId: null, quoteStatus: 'no_rate' })
  })
})
