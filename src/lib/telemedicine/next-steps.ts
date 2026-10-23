// WS7 T6: where the doctor goes after ending a video visit.

export interface VisitNextStepLinks {
  completeVisitHref: string
  writeNoteHref: string
  billHref: string
}

/**
 * The end-of-call links for a video visit. The patient id is only in the URL
 * (internal routing); the screen's labels never show it.
 *
 * WS1 SWITCH POINT: once the WS1 consultation workspace (`src/app/(dashboard)/encounters/[id]`)
 * is in this branch, look the visit's encounter up by `encounters.appointment_id` in the
 * call page and, when one exists, return `/encounters/<encounterId>` for
 * `completeVisitHref` and `writeNoteHref` here. Until then these are the fallback links.
 */
export function visitNextStepLinks(patientId: string): VisitNextStepLinks {
  const id = encodeURIComponent(patientId)
  return {
    completeVisitHref: `/patients/${id}?tab=visits`,
    writeNoteHref: `/patients/${id}/medical-record#notes`,
    billHref: `/cash-desk?patientId=${id}`,
  }
}
