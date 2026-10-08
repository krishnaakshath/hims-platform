import { describe, it, expect } from 'vitest'
import { formatDoctorRegistration } from '@/lib/india/registration'

// Wave F: the doctor's medical-council registration as printed on the
// prescription slip and the discharge summary.
describe('formatDoctorRegistration', () => {
  it('formats an NMC registration (no state)', () => {
    expect(formatDoctorRegistration({ registrationCouncil: 'nmc', registrationStateCode: null, registrationNumber: '998877' })).toBe('NMC 998877')
  })
  it('formats an SMC registration with its state code', () => {
    expect(formatDoctorRegistration({ registrationCouncil: 'smc', registrationStateCode: 'IN-MH', registrationNumber: '12345' })).toBe('SMC IN-MH 12345')
  })
  it('is null when the number, the council or an SMC state is missing', () => {
    expect(formatDoctorRegistration({ registrationCouncil: 'nmc', registrationStateCode: null, registrationNumber: null })).toBeNull()
    expect(formatDoctorRegistration({ registrationCouncil: null, registrationStateCode: null, registrationNumber: '1' })).toBeNull()
    expect(formatDoctorRegistration({ registrationCouncil: 'smc', registrationStateCode: null, registrationNumber: '1' })).toBeNull()
    expect(formatDoctorRegistration({ registrationCouncil: 'nmc', registrationStateCode: null, registrationNumber: '   ' })).toBeNull()
  })
})
