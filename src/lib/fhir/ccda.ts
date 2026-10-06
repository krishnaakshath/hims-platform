import type { PatientFhirData } from '@/lib/fhir/gather'
import { patientToFhir } from '@/lib/fhir/patient'
import { allergiesToFhir, type FhirAllergyIntolerance } from '@/lib/fhir/allergy'
import { conditionsToFhir, type FhirCondition } from '@/lib/fhir/condition'
import { medicationEpisodesToFhir, type FhirMedicationRequest } from '@/lib/fhir/medication-request'
import { observationsToFhir, type FhirObservation } from '@/lib/fhir/observation'

// MedicationDispense is intentionally not composed into any CCD section here.
// Spec §4 names exactly four CCD sections for this plan -- Allergies,
// Medications, Problems, Results -- and there is no standard CCD section
// counterpart for dispense history in that fixed scope. Dispense history
// stays FHIR-only (see src/lib/fhir/bundle.ts, which does include it); this
// is a deliberate scope boundary, not an oversight.

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function allergyEntry(a: FhirAllergyIntolerance): string {
  const reaction = a.reaction[0]
  return `      <entry>
        <allergen>${escapeXml(a.code.text ?? '')}</allergen>
        <reaction>${escapeXml(reaction?.manifestation[0]?.text ?? '')}</reaction>
        <severity>${escapeXml(reaction?.severity ?? '')}</severity>
      </entry>`
}

function conditionEntry(c: FhirCondition): string {
  const code = c.code.coding?.[0]?.code ?? ''
  return `      <entry>
        <problemName>${escapeXml(c.code.text ?? '')}</problemName>
        <code>${escapeXml(code)}</code>
        <recordedDate>${escapeXml(c.recordedDate ?? '')}</recordedDate>
      </entry>`
}

function medicationEntry(m: FhirMedicationRequest): string {
  const dosage = m.dosageInstruction?.[0]?.text ?? ''
  return `      <entry>
        <medicationName>${escapeXml(m.medicationCodeableConcept.text)}</medicationName>
        <dosage>${escapeXml(dosage)}</dosage>
        <status>${escapeXml(m.status)}</status>
        <authoredOn>${escapeXml(m.authoredOn)}</authoredOn>
      </entry>`
}

function observationEntry(o: FhirObservation): string {
  const value = o.valueQuantity ? `${o.valueQuantity.value}${o.valueQuantity.unit ? ` ${o.valueQuantity.unit}` : ''}` : (o.valueString ?? '')
  return `      <entry>
        <testName>${escapeXml(o.code.text ?? '')}</testName>
        <value>${escapeXml(value)}</value>
        <effectiveDateTime>${escapeXml(o.effectiveDateTime)}</effectiveDateTime>
      </entry>`
}

function section(title: string, templateIdComment: string, entriesXml: string[]): string {
  return `    <section>
      <!-- Loosely modeled on CDA template ${templateIdComment}, but not a conformant instance of it; see the document-level comment. -->
      <title>${escapeXml(title)}</title>
${entriesXml.length > 0 ? entriesXml.join('\n') : '      <entry/>'}
    </section>`
}

// A CCD-shaped document, not one validated against the real HL7 CCD XSD
// (spec §4 asks for "the CCD template structure," not schema conformance).
// Every field this function writes into the document is read directly off
// the Task 1 FHIR mapping functions' output (patientToFhir, allergiesToFhir,
// conditionsToFhir, medicationEpisodesToFhir, observationsToFhir) rather than
// re-derived from the raw DB rows a second time -- that's what makes this
// document provably consistent with the FHIR Bundle for the same patient:
// there is exactly one place each fact is computed.
//
// IMPORTANT -- conformance disclaimer: this document deliberately omits the
// real HL7 C-CDA `typeId`/`templateId` OIDs (document-level and per-section)
// that a genuine C-CDA R2.1 CCD instance would carry. This element/section
// structure (<allergen>, <problemName>, no <entry> clinical statements, etc.)
// is NOT the real CDA content model, so asserting those template OIDs would
// be a false machine-readable conformance claim -- a receiving EHR that
// routes on templateId would wrongly treat this as a conformant CCD and
// could silently misimport it. This is a CCD-*shaped* human/summary document
// only (same Allergies/Medications/Problems/Results sections a real CCD
// has), not a validated, conformant C-CDA R2.1 document. See spec §4.
export function toCcdaXml(data: PatientFhirData): string {
  const patient = patientToFhir(data.patient)
  const allergies = allergiesToFhir(data.allergyRows)
  const conditions = conditionsToFhir(data.diagnosisRows)
  const medicationRequests = medicationEpisodesToFhir(data.medicationEpisodeRows)
  const observations = observationsToFhir(data.patient.id, data.labOrderRows)

  const now = new Date().toISOString()
  const patientName = patient.name[0]?.text ?? ''

  const sections = [
    section('Allergies', '2.16.840.1.113883.10.20.22.2.6.1', allergies.map(allergyEntry)),
    section('Active Medications', '2.16.840.1.113883.10.20.22.2.1.1', medicationRequests.map(medicationEntry)),
    section('Problems', '2.16.840.1.113883.10.20.22.2.5.1', conditions.map(conditionEntry)),
    section('Results', '2.16.840.1.113883.10.20.22.2.3.1', observations.map(observationEntry)),
  ]

  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  This is a CCD-shaped patient summary document, NOT a conformant HL7 C-CDA
  R2.1 document. It does not carry the real CDA typeId/templateId
  conformance identifiers, and its element structure (below) is this app's
  own simplified content model, not the real CDA clinical-statement entry
  model. Do not route or validate this document as a real C-CDA instance.
-->
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <title>Continuity of Care Document</title>
  <effectiveTime value="${escapeXml(now)}"/>
  <recordTarget>
    <patientRole>
      <id extension="${escapeXml(patient.id)}"/>
      <patient>
        <name>${escapeXml(patientName)}</name>
        <birthTime value="${escapeXml(patient.birthDate)}"/>
      </patient>
    </patientRole>
  </recordTarget>
  <component>
    <structuredBody>
${sections.map((s) => `      <component>\n${s}\n      </component>`).join('\n')}
    </structuredBody>
  </component>
</ClinicalDocument>
`
}
