// Pure, client-safe lab catalog constants and tariff → quote mapping.
import type { PriceResolution } from '@/lib/tariff/resolve'

export const SAMPLE_TYPES = ['blood', 'serum', 'plasma', 'urine', 'stool', 'sputum', 'swab', 'csf', 'other'] as const
export type SampleType = (typeof SAMPLE_TYPES)[number]

export const SAMPLE_TYPE_LABEL: Record<SampleType, string> = {
  blood: 'Whole blood',
  serum: 'Serum',
  plasma: 'Plasma',
  urine: 'Urine',
  stool: 'Stool',
  sputum: 'Sputum',
  swab: 'Swab',
  csf: 'CSF',
  other: 'Other',
}

export const SAMPLE_CONTAINERS = [
  'edta_lavender', 'plain_red', 'sst_gold', 'fluoride_grey', 'citrate_blue', 'heparin_green', 'urine_container', 'stool_container',
  'swab_tube', 'other',
] as const
export type SampleContainer = (typeof SAMPLE_CONTAINERS)[number]

export const SAMPLE_CONTAINER_LABEL: Record<SampleContainer, string> = {
  edta_lavender: 'EDTA (lavender cap)',
  plain_red: 'Plain (red cap)',
  sst_gold: 'SST gel (gold cap)',
  fluoride_grey: 'Fluoride (grey cap)',
  citrate_blue: 'Citrate (light blue cap)',
  heparin_green: 'Heparin (green cap)',
  urine_container: 'Urine container (sterile cup)',
  stool_container: 'Stool container',
  swab_tube: 'Swab tube (transport medium)',
  other: 'Other container',
}

export const LAB_QUOTE_STATUSES = ['quoted', 'unmapped', 'no_rate', 'service_inactive', 'service_not_found'] as const
export type LabQuoteStatus = (typeof LAB_QUOTE_STATUSES)[number]

/** int4-safe cap on a quoted price (also a DB check). */
export const MAX_QUOTED_PAISE = 1_000_000_000

export interface LabQuote {
  quotedPricePaise: number | null
  quotedTariffRateId: number | null
  quoteStatus: LabQuoteStatus
}

/** `null` means the lab test has no tariff service mapped. */
export function quoteFromResolution(res: PriceResolution | null): LabQuote {
  if (res === null) return { quotedPricePaise: null, quotedTariffRateId: null, quoteStatus: 'unmapped' }
  if (res.ok) {
    if (Number.isInteger(res.amountPaise) && res.amountPaise >= 0 && res.amountPaise <= MAX_QUOTED_PAISE) {
      return { quotedPricePaise: res.amountPaise, quotedTariffRateId: res.rateId, quoteStatus: 'quoted' }
    }
    // A rate outside the int4-safe range is a data error: the order is still created, unpriced.
    return { quotedPricePaise: null, quotedTariffRateId: null, quoteStatus: 'no_rate' }
  }
  const quoteStatus: LabQuoteStatus = res.reason === 'invalid_date' ? 'no_rate' : res.reason
  return { quotedPricePaise: null, quotedTariffRateId: null, quoteStatus }
}
