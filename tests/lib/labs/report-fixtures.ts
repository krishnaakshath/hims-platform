// SP5 Task 13: a lab report source shared by the report data and PDF tests (not a test file).
import type { LabReportSource } from '@/lib/labs/report-data'
import { LAB_ANALYTE_SEED } from '@/db/seed-india-data'
import { flagAnalyteValue, rangeText, selectRange, type Interpretation, type LabResultFlag } from '@/lib/labs/analytes'

export const SRC: LabReportSource = {
  hospital: { name: 'Test Hospital', legalName: 'Test Hospital Trust', site: 'Main campus' },
  reportNumber: 'LR-2099-000001',
  version: 1,
  patient: { id: 'RD-0001', name: 'Asha Rao', dob: '2059-03-03', uhid: 'UH-000042', gender: 'female' },
  provider: { name: 'Dr Meera Iyer', registrationCouncil: 'smc', registrationStateCode: 'KA', registrationNumber: '12345' },
  orders: [
    {
      testName: 'Haemoglobin', testCode: '718-7', sampleId: 'L99030200429', testReferenceRange: '12-15 g/dL',
      collectedAt: new Date('2099-03-02T04:00:00Z'), receivedAt: new Date('2099-03-02T06:00:00Z'),
      verifiedAt: new Date('2099-03-02T10:00:00Z'), verifiedByName: 'Dr Path One',
      result: { value: '11.2', unit: 'g/dL', referenceRange: '12-16 g/dL', flag: 'abnormal' },
    },
    {
      testName: 'Glucose, fasting', testCode: '1558-6', sampleId: null, testReferenceRange: '70-110 mg/dL',
      collectedAt: null, receivedAt: null,
      verifiedAt: new Date('2099-03-02T11:00:00Z'), verifiedByName: 'Dr Path Two',
      result: { value: '92', unit: 'mg/dL', referenceRange: null, flag: 'normal' },
    },
    {
      testName: 'Potassium', testCode: '2823-3', sampleId: null, testReferenceRange: null,
      collectedAt: null, receivedAt: null,
      verifiedAt: new Date('2099-03-02T12:00:00Z'), verifiedByName: 'Dr Path One',
      result: { value: '6.9', unit: 'mmol/L', referenceRange: '3.5-5.1 mmol/L', flag: 'critical' },
    },
  ],
}

// WS4 T10: a verified CBC for an adult woman with every analyte computed by the same pure rules
// the entry form and the server run (seeded definitions, female adult range, automatic flag).
// Haemoglobin 6.5 g/dL is critical low; every other value is normal.

export const CBC_VALUES: Record<string, string> = {
  HGB: '6.5', WBC: '7.2', NEUT: '60', LYMPH: '30', MONO: '6', EOS: '3', BASO: '1', PLT: '250', RBC: '4.6', HCT: '40', MCV: '88', MCH: '29', MCHC: '33',
}

export interface CbcAnalyteFixture {
  analyteId: number; code: string; name: string; value: string; unit: string | null; referenceRange: string | null
  flag: LabResultFlag; interpretation: Interpretation | null; flagSource: 'auto' | 'manual'; flagReason: string | null; loincCode: string | null
}

export const CBC_ANALYTES: CbcAnalyteFixture[] = LAB_ANALYTE_SEED['CBC-DIFF'].map((d, i) => {
  const def = { ...d, id: 900 + i }
  const range = selectRange(def.ranges, 'female', 30 * 365)
  const value = CBC_VALUES[d.code]
  const computed = flagAnalyteValue(def, value, range)!
  return {
    analyteId: def.id, code: d.code, name: d.name, value, unit: d.unit, referenceRange: rangeText(range, d.unit),
    flag: computed.flag, interpretation: computed.interpretation, flagSource: 'auto', flagReason: null, loincCode: d.loincCode,
  }
})

export const CBC_SRC: LabReportSource = {
  ...SRC,
  orders: [{
    testName: 'Complete blood count with differential', testCode: 'CBC-DIFF', sampleId: 'L99030200430', testReferenceRange: null,
    collectedAt: new Date('2099-03-02T04:00:00Z'), receivedAt: new Date('2099-03-02T06:00:00Z'),
    verifiedAt: new Date('2099-03-02T10:00:00Z'), verifiedByName: 'Dr Path One',
    result: { value: '13 analytes', unit: null, referenceRange: null, flag: 'critical', analytes: CBC_ANALYTES },
    cosignedBy: [],
  }],
}
