'use client'

// Client-side mirror of ImagingAttachment (src/lib/queries/documents.ts) --
// kept as a separate type rather than importing the query-layer type
// directly, matching WorklistOrder's own convention of mirroring its
// server-side row shape rather than importing it (Task 4's WorklistRow etc.
// live behind server-only query modules).
export interface AttachmentView {
  id: number
  name: string
  fileUrl: string | null
  fileType: string
  filedAt: Date | null
  filedByName: string | null
}

const IMAGE_TYPES = new Set(['JPG', 'PNG', 'WEBP'])

/**
 * A row of thumbnail/chip links for a lab order's imaging attachments.
 * Renders nothing when there are none. Built once here and shared by every
 * surface that shows an order's imaging (LabWorklist, EnterLabResultModal,
 * LabResultsSection) rather than re-implemented per surface.
 *
 * Every link points at the audit-logged download route
 * (`/api/documents/[id]/download`, from the document-assignment plan) so
 * that every *view* of a patient image is logged, not just the upload --
 * this deliberately never renders a bare `fileUrl` as the href or the
 * thumbnail's src, since the blob store is private and only that route can
 * actually reach the bytes.
 */
export function ImagingAttachmentStrip({ attachments }: { attachments: AttachmentView[] }) {
  if (attachments.length === 0) return null

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {attachments.map((a) => {
        const filedBy = a.filedByName
          ? `${a.name} — filed by ${a.filedByName}${a.filedAt ? ` on ${a.filedAt.toLocaleString()}` : ''}`
          : a.name
        return (
          <a
            key={a.id}
            href={`/api/documents/${a.id}/download`}
            title={filedBy}
            className="block overflow-hidden rounded-md border border-border"
          >
            {IMAGE_TYPES.has(a.fileType) ? (
              <img src={`/api/documents/${a.id}/download`} alt={a.name} className="h-16 w-16 object-cover" />
            ) : (
              <span className="flex h-16 w-16 items-center justify-center px-1 text-center text-[0.65rem] font-medium text-muted-foreground">
                {a.name}
              </span>
            )}
          </a>
        )
      })}
    </div>
  )
}
