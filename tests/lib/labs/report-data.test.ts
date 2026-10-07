// SP5 Task 13: the lab report data shape (pure builder) and the PDF-safe text helper.
import { describe, it, expect } from 'vitest'
import { buildLabReportData, flagLabel, hospitalFromBrand, toPdfSafeText, type LabReportSource } from '@/lib/labs/report-data'
import { SRC } from './report-fixtures'

const NOW = new Date('2099-03-04T06:00:00Z')

describe('buildLabReportData', () => {
  it('builds IST age, registration and range fallback', () => {
    const d = buildLabReportData(SRC, new Date('2099-03-02T19:00:00Z')) // IST 3 Mar 2099, 00:30
    expect(d.patient.ageYears).toBe(40)
    expect(d.referringDoctor).toEqual({ name: 'Dr Meera Iyer', registration: 'SMC KA 12345' })
    expect(d.rows[1].referenceRange).toBe('70-110 mg/dL')
    expect(d.rows[0].referenceRange).toBe('12-16 g/dL')
    expect(d.rows[2].referenceRange).toBe('3.5-5.1 mmol/L')
    // 2 Mar 2099 18:29 UTC is still 2 Mar in IST: the birthday has not come yet.
    expect(buildLabReportData(SRC, new Date('2099-03-02T18:29:00Z')).patient.ageYears).toBe(39)
  })

  it('keeps the source order, projects explicit fields and lists distinct verifiers in row order', () => {
    const d = buildLabReportData(SRC, NOW)
    expect(d.rows.map((r) => r.testName)).toEqual(['Haemoglobin', 'Glucose, fasting', 'Potassium'])
    expect(d.rows[0]).toEqual({
      testName: 'Haemoglobin', testCode: '718-7', sampleId: 'L99030200429', value: '11.2', unit: 'g/dL', referenceRange: '12-16 g/dL',
      flag: 'abnormal', collectedAt: '2099-03-02T04:00:00.000Z', receivedAt: '2099-03-02T06:00:00.000Z',
      verifiedByName: 'Dr Path One', verifiedAt: '2099-03-02T10:00:00.000Z',
    })
    expect(d.verifiers).toEqual(['Dr Path One', 'Dr Path Two'])
    expect(d).toMatchObject({
      hospital: { name: 'Test Hospital', legalName: 'Test Hospital Trust', site: 'Main campus' },
      reportNumber: 'LR-2099-000001', version: 1, generatedAt: NOW.toISOString(),
      patient: { name: 'Asha Rao', uhid: 'UH-000042', patientId: 'RD-0001', gender: 'Female' },
    })
    expect(Object.keys(d.patient).sort()).toEqual(['ageYears', 'gender', 'name', 'patientId', 'uhid'])
  })

  it('NMC, SMC without a state, and no number', () => {
    const reg = (provider: Partial<LabReportSource['provider']>) => buildLabReportData({ ...SRC, provider: { ...SRC.provider, ...provider } }, NOW).referringDoctor.registration
    expect(reg({ registrationCouncil: 'nmc', registrationNumber: '998877' })).toBe('NMC 998877')
    expect(reg({ registrationStateCode: null })).toBeNull()
    expect(reg({ registrationNumber: null })).toBeNull()
    expect(reg({ registrationCouncil: null })).toBeNull()
  })

  it('only verified results reach the report', () => {
    const unverified = { ...SRC.orders[1], testName: 'Unverified', verifiedAt: null, verifiedByName: null }
    const d = buildLabReportData({ ...SRC, orders: [SRC.orders[0], unverified] }, NOW)
    expect(d.rows.map((r) => r.testName)).toEqual(['Haemoglobin'])
  })

  it('has no Aadhaar or ABHA anywhere in the shape', () => {
    const json = JSON.stringify(buildLabReportData(SRC, NOW))
    expect(json).not.toMatch(/aadhaar|abha/i)
    expect(json).not.toMatch(/2059-03-03/) // no date of birth, only the age
  })

  it('hospitalFromBrand takes the brand names', () => {
    expect(hospitalFromBrand({ name: 'X', legalName: 'X Trust' })).toEqual({ name: 'X', legalName: 'X Trust', site: null })
    expect(hospitalFromBrand({ name: 'X', legalName: 'X Trust' }, 'Annex')).toEqual({ name: 'X', legalName: 'X Trust', site: 'Annex' })
  })
})

describe('flagLabel', () => {
  it('labels only out-of-range results', () => {
    expect(flagLabel('normal')).toBe('')
    expect(flagLabel('abnormal')).toBe('ABNORMAL')
    expect(flagLabel('critical')).toBe('CRITICAL')
  })
})

describe('toPdfSafeText', () => {
  it('toPdfSafeText replaces non-WinAnsi characters', () => {
    expect(toPdfSafeText('राम  Kumar\t')).toBe('??? Kumar')
  })

  it('keeps Latin-1, maps typographic punctuation to ASCII and collapses whitespace', () => {
    expect(toPdfSafeText('José Müller · 5 µmol/L ±2')).toBe('José Müller · 5 µmol/L ±2')
    expect(toPdfSafeText('‘a’ “b” – c — d … •')).toBe(`'a' "b" - c - d ... *`)
    expect(toPdfSafeText('10:30 am\nline two')).toBe('10:30 am line two')
    expect(toPdfSafeText('😀 ok ₹')).toBe('? ok ?')
    expect(toPdfSafeText('')).toBe('')
    expect(toPdfSafeText('\u0000ctl\u0007')).toBe('?ctl?')
  })
})
