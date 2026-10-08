// Loose FHIR shapes for NHCX bundles: builders produce plain JSON; the
// structural validator (validate.ts) is what checks them.
export type FhirResource = { resourceType: string; id: string } & Record<string, unknown>
export type FhirBundleEntry = { fullUrl: string; resource: FhirResource }
export type FhirBundle = {
  resourceType: 'Bundle'
  id: string
  meta: { profile: string[] }
  identifier: { value: string }
  type: 'collection'
  timestamp: string
  entry: FhirBundleEntry[]
}

export const ref = (id: string) => ({ reference: `urn:uuid:${id}` })
export const entry = (resource: FhirResource): FhirBundleEntry => ({ fullUrl: `urn:uuid:${resource.id}`, resource })
export const newId = () => globalThis.crypto.randomUUID()
