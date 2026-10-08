// Wave F: a doctor's medical-council registration as printed on clinical
// documents (prescription slip, discharge summary). NMC numbers are national;
// an SMC number is only meaningful with its state, so an SMC registration with
// no state prints nothing rather than an ambiguous number. Pure.

export interface DoctorRegistrationSource {
  registrationCouncil: 'nmc' | 'smc' | null
  registrationStateCode: string | null
  registrationNumber: string | null
}

export function formatDoctorRegistration(r: DoctorRegistrationSource): string | null {
  const number = r.registrationNumber?.trim()
  if (!number) return null
  if (r.registrationCouncil === 'nmc') return `NMC ${number}`
  if (r.registrationCouncil === 'smc' && r.registrationStateCode) return `SMC ${r.registrationStateCode} ${number}`
  return null
}
