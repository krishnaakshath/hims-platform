// SP5 Task 13: a lab report source shared by the report data and PDF tests (not a test file).
import type { LabReportSource } from '@/lib/labs/report-data'

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
