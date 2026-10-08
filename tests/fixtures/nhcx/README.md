# NHCX fixture bundles

Official examples from the NRCeS "FHIR Implementation Guide for ABDM", package `ndhm.in` version 6.5.0
(built 2025-05-08), downloaded 2026-10-08 from `https://nrces.in/ndhm/fhir/r4/<name>.json`.

De-identification applied to every file (mandatory; the originals identify the patient by Aadhaar):
- every identifier with type code `ADN` or system `https://uidai.gov.in/` is replaced by
  `{ type: ndhm-identifier-type-code ABHA, system: https://healthid.ndhm.gov.in, value: 91-0000-0000-0001 }`;
- every remaining standalone 12-digit number (telephone numbers in the examples) becomes `9000000000`;
- every dashed 4-4-4 digit group becomes `0000-0000-0000`;
- JSON re-serialised with two-space indentation. No other change.
