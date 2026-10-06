// Single source of truth for the documents enum's display labels. Lives in
// its own module (not inside DocumentsReportTable.tsx, which both this and
// ReceiveDocumentModal.tsx used to import from) because DocumentsReportTable
// imports ReceiveDocumentModal (to open it from the "Receive Document"
// button) -- having ReceiveDocumentModal import back from
// DocumentsReportTable made a circular module dependency that threw
// "Cannot access 'DOCUMENT_TYPE_TEXT' before initialization" at runtime
// (confirmed live via the dev server). DocumentsReportTable re-exports
// `DOCUMENT_TYPE_TEXT` from here so existing/external references to it as
// "the map DocumentsReportTable exports" keep working.
export type DocumentType =
  | 'other'
  | 'drivers_license'
  | 'legal_document'
  | 'insurance_card_primary_front'
  | 'insurance_card_primary_back'
  | 'insurance_card_secondary_front'
  | 'insurance_card_secondary_back'
  | 'insurance_eob'
  | 'insurance_authorization'
  | 'imaging_result'

export const DOCUMENT_TYPE_TEXT: Record<DocumentType, string> = {
  other: 'Other',
  drivers_license: "Driver's License",
  legal_document: 'Legal Document',
  insurance_card_primary_front: 'Insurance Card — Primary Front',
  insurance_card_primary_back: 'Insurance Card — Primary Back',
  insurance_card_secondary_front: 'Insurance Card — Secondary Front',
  insurance_card_secondary_back: 'Insurance Card — Secondary Back',
  insurance_eob: 'Insurance EOB',
  insurance_authorization: 'Insurance Authorization',
  imaging_result: 'Imaging Result',
}
