import { describe, it, expect } from 'vitest'
import { brand } from '@/lib/brand'
import { buildDischargeSummary, type DischargeSummarySource } from '@/lib/encounters/discharge-summary'

const NOW = new Date('2026-10-06T04:30:00Z')

const SRC: DischargeSummarySource = {
  patient: {
    id: 'RD-0042', uhid: 'UH-000042', name: 'Asha Rao', dob: '1980-10-03', gender: 'female',
    abhaNumber: '91234567890123', abhaAddress: 'asha.rao@abdm',
    addressLine1: '12 MG Road', addressLine2: null, city: 'Pune', district: 'Pune', stateCode: 'IN-MH', pinCode: '411001',
    isMlc: true, mlcNumber: 'MLC-7',
  },
  admission: {
    id: 55, admissionType: 'emergency', status: 'discharged',
    admittedAt: new Date('2026-10-01T20:00:00Z'), // IST 2 Oct 01:30
    dischargedAt: new Date('2026-10-05T05:00:00Z'), // IST 5 Oct 10:30
    dischargeDiagnosis: 'Community-acquired pneumonia', dischargeDrugs: 'Amoxicillin', dischargeDevices: 'None', dischargeDiet: 'Soft', dischargeSummaryNotes: 'Recovered well',
  },
  attending: { providerId: 3, name: 'Dr. Meera Iyer', registrationCouncil: 'smc', registrationStateCode: 'IN-MH', registrationNumber: '12345', departmentName: 'General Medicine' },
  lastWard: 'Ward B',
  followUp: {
    dueDate: '2026-10-19', windowStart: '2026-10-16', windowEnd: '2026-10-26', reason: 'Chest X-ray review', status: 'scheduled',
    appointment: { startsAt: new Date('2026-10-19T04:30:00Z') },
  },
  signature: { signerTypedName: 'Dr. Meera Iyer', signedAt: new Date('2026-10-05T05:01:00Z') },
}

describe('buildDischargeSummary', () => {
  it('builds the shape with IST dates and length of stay', () => {
    const d = buildDischargeSummary(SRC, NOW, 'pi')
    expect(d.admission).toEqual({ id: 55, admissionType: 'emergency', admittedOn: '2026-10-02', dischargedOn: '2026-10-05', lengthOfStayDays: 3, lastWard: 'Ward B' })
    expect(d.attending).toEqual({ providerId: 3, name: 'Dr. Meera Iyer', registration: 'SMC IN-MH 12345', departmentName: 'General Medicine' })
    expect(d.timezone).toBe('Asia/Kolkata')
    expect(d.generatedAt).toBe('2026-10-06T04:30:00.000Z')
    expect(d.hospitalName).toBe(brand.legalName)
  })

  it('projects the patient explicitly: formatted ABHA, composed address, age at discharge', () => {
    const d = buildDischargeSummary(SRC, NOW, 'admin')
    expect(d.patient).toEqual({
      id: 'RD-0042', uhid: 'UH-000042', name: 'Asha Rao', ageYears: 46, gender: 'Female',
      abhaNumber: '91-2345-6789-0123', abhaAddress: 'asha.rao@abdm',
      address: '12 MG Road, Pune, Pune, Maharashtra 411001', isMlc: true, mlcNumber: 'MLC-7',
    })
  })

  it('carries the clinical sections, follow-up and signature for a clinical role', () => {
    const d = buildDischargeSummary(SRC, NOW, 'crc')
    expect(d.clinical).toEqual({ diagnosis: 'Community-acquired pneumonia', drugs: 'Amoxicillin', devices: 'None', diet: 'Soft', notes: 'Recovered well' })
    expect(d.followUp).toEqual({ dueDate: '2026-10-19', windowStart: '2026-10-16', windowEnd: '2026-10-26', reason: 'Chest X-ray review', status: 'scheduled', appointmentStartsAt: '2026-10-19T04:30:00.000Z' })
    expect(d.signature).toEqual({ signerTypedName: 'Dr. Meera Iyer', signedAt: '2026-10-05T05:01:00.000Z' })
  })

  it('gives the front desk (and the default) no clinical sections and no ABHA', () => {
    for (const d of [buildDischargeSummary(SRC, NOW, 'frontdesk'), buildDischargeSummary(SRC, NOW)]) {
      expect(d.clinical).toBeNull()
      expect(d.patient.abhaNumber).toBeNull()
      expect(d.patient.abhaAddress).toBeNull()
      const json = JSON.stringify(d)
      for (const text of ['pneumonia', 'Amoxicillin', 'Recovered well', '9123', 'asha.rao@abdm']) expect(json).not.toContain(text)
      // Admin-visible facts the front desk still needs.
      expect(d.followUp?.reason).toBe('Chest X-ray review')
      expect(d.admission.dischargedOn).toBe('2026-10-05')
    }
  })

  it('has no Aadhaar anywhere in the shape', () => {
    expect(JSON.stringify(buildDischargeSummary(SRC, NOW, 'admin'))).not.toMatch(/aadhaar/i)
  })

  it('same-day discharge counts as 1 day', () => {
    const d = buildDischargeSummary({ ...SRC, admission: { ...SRC.admission, admittedAt: new Date('2026-10-05T00:30:00Z'), dischargedAt: new Date('2026-10-05T12:00:00Z') } }, NOW, 'pi')
    expect(d.admission).toMatchObject({ admittedOn: '2026-10-05', dischargedOn: '2026-10-05', lengthOfStayDays: 1 })
  })

  it('formats NMC registration, and nulls an incomplete one, a missing follow-up and a missing signature', () => {
    const nmc = buildDischargeSummary({ ...SRC, attending: { ...SRC.attending, registrationCouncil: 'nmc', registrationStateCode: null, registrationNumber: '998877' } }, NOW, 'pi')
    expect(nmc.attending.registration).toBe('NMC 998877')
    const none = buildDischargeSummary({ ...SRC, attending: { ...SRC.attending, registrationCouncil: null, registrationNumber: null }, followUp: null, signature: null, lastWard: null }, NOW, 'pi')
    expect(none.attending.registration).toBeNull()
    expect(none.followUp).toBeNull()
    expect(none.signature).toBeNull()
    expect(none.admission.lastWard).toBeNull()
    const smcNoState = buildDischargeSummary({ ...SRC, attending: { ...SRC.attending, registrationStateCode: null } }, NOW, 'pi')
    expect(smcNoState.attending.registration).toBeNull()
  })

  it('a patient with no address parts or ABHA gets nulls', () => {
    const d = buildDischargeSummary({ ...SRC, patient: { ...SRC.patient, addressLine1: null, city: null, district: null, stateCode: null, pinCode: null, abhaNumber: null, abhaAddress: null, gender: null, uhid: null } }, NOW, 'pi')
    expect(d.patient).toMatchObject({ address: null, abhaNumber: null, abhaAddress: null, gender: null, uhid: null })
  })

  it('a follow-up whose appointment is gone has no appointment time', () => {
    const d = buildDischargeSummary({ ...SRC, followUp: { ...SRC.followUp!, status: 'planned', appointment: null } }, NOW, 'pi')
    expect(d.followUp?.appointmentStartsAt).toBeNull()
  })
})
