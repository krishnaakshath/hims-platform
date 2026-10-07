// PROVISIONAL identifier system URIs. These must be confirmed against the
// NRCeS / ABDM FHIR profiles in SP8 before any external interop relies on them.
export const ABHA_NUMBER_SYSTEM = 'https://healthid.abdm.gov.in'
export const ABHA_ADDRESS_SYSTEM = 'https://healthid.abdm.gov.in/abha-address'

// PROVISIONAL (SP8): the hospital's own UHID namespace.
export function uhidSystem(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL
  return base ? `${base}/fhir/sid/uhid` : 'urn:x-local:uhid'
}
