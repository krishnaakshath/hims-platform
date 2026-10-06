import { getDb } from '@/db/client'
import { mockPayments } from '@/db/schema'
import { luhnCheck } from '@/lib/mock-payment'

export interface CreateMockPaymentInput {
  patientId: string
  chargeId: number | null
  amountCents: number
  cardNumber: string
  expMonth: number
  expYear: number
}

// SAFETY: `input.cardNumber` and any CVC the caller collected are used only
// in-memory for the Luhn arithmetic below and are never passed to this
// function's return value or persisted -- only the last 4 digits are
// written to the database. See the plan's Global Constraints "Mock-payment
// safety rule".
export async function createMockPayment(input: CreateMockPaymentInput) {
  const digits = input.cardNumber.replace(/\D/g, '')
  const result = luhnCheck(digits) ? 'success' as const : 'failed' as const
  const [created] = await getDb().insert(mockPayments).values({
    patientId: input.patientId,
    chargeId: input.chargeId,
    amountCents: input.amountCents,
    cardLast4: digits.slice(-4),
    expMonth: input.expMonth,
    expYear: input.expYear,
    result,
  }).returning()
  return created
}
