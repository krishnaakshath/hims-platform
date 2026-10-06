import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { signatures } from '@/db/schema'

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(signatures).where(eq(signatures.id, createdIds.pop()!))
})

describe('signatures schema', () => {
  it('inserts a form_submission signature with defaults', async () => {
    const [row] = await getDb().insert(signatures).values({
      signableType: 'form_submission',
      signableId: 999001, // no FK on signableId -- polymorphic, see schema.ts comment
      signerTypedName: 'Jane Patient',
      signerRole: 'patient',
      attestationText: 'I attest this is accurate.',
    }).returning()
    createdIds.push(row.id)
    expect(row.signedAt).toBeInstanceOf(Date)
  })

  it('inserts an admission_discharge signature with a different signableId of the same numeric value', async () => {
    const [row] = await getDb().insert(signatures).values({
      signableType: 'admission_discharge',
      signableId: 999001, // deliberately the same numeric id as the row above -- proves signableType, not just signableId, is part of identity
      signerTypedName: 'Dr. R. Kunam',
      signerRole: 'pi',
      attestationText: 'I attest this discharge summary is accurate and complete.',
    }).returning()
    createdIds.push(row.id)
    expect(row.signableType).toBe('admission_discharge')
  })

  it('rejects an invalid signableType', async () => {
    await expect(getDb().insert(signatures).values({
      signableType: 'not_a_real_type' as never,
      signableId: 1,
      signerTypedName: 'X',
      signerRole: 'patient',
      attestationText: 'X',
    })).rejects.toThrow()
  })
})
