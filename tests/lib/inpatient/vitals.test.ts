// WS3 T7: nursing vitals vocabulary. Lane ruling R4: one vitals table (encounter_vitals), so the
// reading itself is the WS1 vitalsInputSchema; this adds the charting time and the ward warnings.
import { describe, it, expect } from 'vitest'
import { nursingVitalsSchema, vitalWarnings } from '@/lib/inpatient/vitals'
import { toVitalsColumns } from '@/lib/encounters/vitals'

const NOW = new Date('2099-05-01T03:15:00Z') // 08:45 IST
const parse = (body: unknown) => nursingVitalsSchema(NOW).safeParse(body)

const empty = { systolicMmhg: null, diastolicMmhg: null, pulseBpm: null, tempDeciC: null, spo2Pct: null, respRate: null }

describe('nursingVitalsSchema', () => {
  it('accepts a reading with an IST charting time and returns the instant', () => {
    const r = parse({ pulseBpm: 88, tempC: 37.2, recordedAt: '2099-05-01T08:30:00+05:30' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.recordedAt?.toISOString()).toBe('2099-05-01T03:00:00.000Z')
      expect(r.data.reading).toEqual({ pulseBpm: 88, tempC: 37.2 })
    }
  })

  it('accepts a reading with no charting time (stored as now)', () => {
    const r = parse({ spo2Pct: 97 })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.recordedAt).toBeUndefined()
  })

  it('refuses an empty reading, and a note with no measurement', () => {
    expect(parse({}).success).toBe(false)
    expect(parse({ recordedAt: '2099-05-01T08:30:00+05:30' }).success).toBe(false)
    expect(parse({ notes: 'patient asleep' }).success).toBe(false)
  })

  it('refuses a temperature of 50 °C and two decimals', () => {
    expect(parse({ tempC: 50 }).success).toBe(false)
    expect(parse({ tempC: 37.25 }).success).toBe(false)
  })

  it('refuses a charting time more than 5 minutes in the future; allows up to 5', () => {
    expect(parse({ pulseBpm: 80, recordedAt: '2099-05-01T08:51:00+05:30' }).success).toBe(false)
    expect(parse({ pulseBpm: 80, recordedAt: '2099-05-01T08:50:00+05:30' }).success).toBe(true)
  })

  it('refuses a charting time without an offset, and unknown keys', () => {
    expect(parse({ pulseBpm: 80, recordedAt: '2099-05-01T08:30:00' }).success).toBe(false)
    expect(parse({ pulseBpm: 80, admissionId: 3 }).success).toBe(false)
  })
})

describe('storage conversion (reused from WS1)', () => {
  it('38.4 °C and 62.5 kg store as 384 deci-°C and 62500 g', () => {
    const c = toVitalsColumns({ tempC: 38.4, weightKg: 62.5 })
    expect(c.tempDeciC).toBe(384)
    expect(c.weightG).toBe(62500)
  })
})

describe('vitalWarnings', () => {
  it('flags fever at 38.4 °C and hypoxia at SpO2 91', () => {
    expect(vitalWarnings({ ...empty, tempDeciC: 384, spo2Pct: 91 })).toEqual(['fever', 'hypoxia'])
  })

  it('applies each threshold at its boundary', () => {
    expect(vitalWarnings({ ...empty, tempDeciC: 380 })).toEqual(['fever'])
    expect(vitalWarnings({ ...empty, tempDeciC: 379 })).toEqual([])
    expect(vitalWarnings({ ...empty, tempDeciC: 349 })).toEqual(['hypothermia'])
    expect(vitalWarnings({ ...empty, tempDeciC: 350 })).toEqual([])
    expect(vitalWarnings({ ...empty, spo2Pct: 94 })).toEqual([])
    expect(vitalWarnings({ ...empty, systolicMmhg: 89 })).toEqual(['hypotension'])
    expect(vitalWarnings({ ...empty, systolicMmhg: 90 })).toEqual([])
    expect(vitalWarnings({ ...empty, systolicMmhg: 180 })).toEqual(['hypertension'])
    expect(vitalWarnings({ ...empty, systolicMmhg: 150, diastolicMmhg: 110 })).toEqual(['hypertension'])
    expect(vitalWarnings({ ...empty, systolicMmhg: 179, diastolicMmhg: 109 })).toEqual([])
    expect(vitalWarnings({ ...empty, pulseBpm: 101 })).toEqual(['tachycardia'])
    expect(vitalWarnings({ ...empty, pulseBpm: 100 })).toEqual([])
    expect(vitalWarnings({ ...empty, pulseBpm: 49 })).toEqual(['bradycardia'])
    expect(vitalWarnings({ ...empty, pulseBpm: 50 })).toEqual([])
    expect(vitalWarnings({ ...empty, respRate: 25 })).toEqual(['tachypnoea'])
    expect(vitalWarnings({ ...empty, respRate: 24 })).toEqual([])
  })

  it('returns nothing for a normal set', () => {
    expect(vitalWarnings({ systolicMmhg: 120, diastolicMmhg: 80, pulseBpm: 76, tempDeciC: 368, spo2Pct: 98, respRate: 16 })).toEqual([])
  })
})
