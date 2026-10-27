// WS1 T2: the consultation record patch (PUT /api/encounters/[id]/consult). Every field is
// optional; null clears it; at least one key must be present.
import { z } from 'zod'

const text = z.string().trim().max(4000).nullable().optional()

export const consultPatchSchema = z.object({
  chiefComplaint: text,
  historyPresentIllness: text,
  pastHistory: text,
  familyHistory: text,
  personalHistory: text,
  examination: text,
  advice: text,
  noDiagnosisReason: z.string().trim().max(300).nullable().optional(),
}).strict().refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' })

export type ConsultPatch = z.infer<typeof consultPatchSchema>
