// WS1 T5 (spec ruling 10): signing a clinical note reuses the discharge pattern -- the signer types
// their own name and ticks the attestation. Pure (no DB) so the sign dialog can import the exact
// attestation sentence that is stored on the signatures row.
import { z } from 'zod'

export const NOTE_ATTESTATION = 'I attest that this note is accurate and that I wrote or reviewed it.'

export const noteSignSchema = z.object({ typedName: z.string().trim().min(1).max(120), attestation: z.literal(true) }).strict()
