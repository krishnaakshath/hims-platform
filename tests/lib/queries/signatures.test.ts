import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { signatures } from '@/db/schema'
import { createSignature, getSignaturesForSignable, getLatestSignatureForSignable } from '@/lib/queries/signatures'

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(signatures).where(eq(signatures.id, createdIds.pop()!))
})

describe('signatures queries', () => {
  it('creates a signature and reads it back by signableType+signableId', async () => {
    const created = await createSignature({ signableType: 'form_submission', signableId: 888001, signerTypedName: 'Jane Patient', signerRole: 'patient', attestationText: 'I attest.' })
    createdIds.push(created.id)

    const rows = await getSignaturesForSignable('form_submission', 888001)
    expect(rows.some((r) => r.id === created.id)).toBe(true)

    const latest = await getLatestSignatureForSignable('form_submission', 888001)
    expect(latest?.id).toBe(created.id)
  })

  it('keeps the two signableTypes independent for the same numeric id', async () => {
    const formSig = await createSignature({ signableType: 'form_submission', signableId: 888002, signerTypedName: 'A', signerRole: 'patient', attestationText: 'x' })
    const dischargeSig = await createSignature({ signableType: 'admission_discharge', signableId: 888002, signerTypedName: 'B', signerRole: 'pi', attestationText: 'y' })
    createdIds.push(formSig.id, dischargeSig.id)

    const formRows = await getSignaturesForSignable('form_submission', 888002)
    const dischargeRows = await getSignaturesForSignable('admission_discharge', 888002)
    expect(formRows.some((r) => r.id === dischargeSig.id)).toBe(false)
    expect(dischargeRows.some((r) => r.id === formSig.id)).toBe(false)
  })

  it('returns null from getLatestSignatureForSignable when none exists', async () => {
    const latest = await getLatestSignatureForSignable('admission_discharge', 999999999)
    expect(latest).toBeNull()
  })
})
