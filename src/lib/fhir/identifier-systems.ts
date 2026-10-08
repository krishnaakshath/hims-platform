// Verified: NRCeS FHIR IG for ABDM 6.5.0, Patient-example-01 (ABHA number system).
export const ABHA_NUMBER_SYSTEM = 'https://healthid.ndhm.gov.in'
// No ABHA-address identifier system appears in the 6.5.0 examples (SP8 UNVERIFIED U14):
// the ABHA address is emitted with type text 'ABHA Address' and no system.

// PROVISIONAL (SP8): the hospital's own UHID namespace.
export function uhidSystem(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL
  return base ? `${base}/fhir/sid/uhid` : 'urn:x-local:uhid'
}
