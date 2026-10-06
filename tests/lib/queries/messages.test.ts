import { describe, it, expect, afterEach } from 'vitest'
import { inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { messages } from '@/db/schema'
import {
  listMessagesForPatient,
  sendMessage,
  markReadByProvider,
  markReadByPatient,
  getUnreadCountForProvider,
  getUnreadCountForPatient,
  listMessageThreads,
  getPatientDisplayName,
} from '@/lib/queries/messages'

const PATIENT_A = 'RD-0001'
const PATIENT_B = 'RD-0002'

// Every test in this file inserts real rows into the shared dev DB -- track
// and delete every one created, same pattern as tests/api/form-submissions.test.ts.
const createdIds: number[] = []
afterEach(async () => {
  if (createdIds.length > 0) {
    await getDb().delete(messages).where(inArray(messages.id, createdIds))
    createdIds.length = 0
  }
})

async function seed(patientId: string, senderRole: 'provider' | 'patient' | 'system', body: string) {
  const senderName = senderRole === 'provider' ? 'Dr. Rajiv Kunam' : senderRole === 'system' ? 'HIMS (Automated)' : 'Test Patient'
  const created = await sendMessage(patientId, senderRole, senderName, body)
  createdIds.push(created.id)
  return created
}

describe('listMessagesForPatient', () => {
  it('returns only that patient\'s messages, oldest first', async () => {
    const m1 = await seed(PATIENT_A, 'provider', 'first')
    const m2 = await seed(PATIENT_A, 'patient', 'second')
    await seed(PATIENT_B, 'provider', 'a different thread entirely')

    const thread = await listMessagesForPatient(PATIENT_A)
    const ids = thread.map((m) => m.id)
    expect(ids).toContain(m1.id)
    expect(ids).toContain(m2.id)
    expect(thread.every((m) => m.patientId === PATIENT_A)).toBe(true)
    expect(thread.findIndex((m) => m.id === m1.id)).toBeLessThan(thread.findIndex((m) => m.id === m2.id))
  })
})

describe('markReadByProvider / markReadByPatient', () => {
  it('only marks the matching sender role, and only in that patient\'s thread', async () => {
    const providerMsg = await seed(PATIENT_A, 'provider', 'from the doctor')
    const patientMsg = await seed(PATIENT_A, 'patient', 'from the patient')
    const otherThreadMsg = await seed(PATIENT_B, 'patient', 'unrelated thread')

    await markReadByProvider(PATIENT_A)
    let [refreshedProviderMsg] = await getDb().select().from(messages).where(inArray(messages.id, [providerMsg.id]))
    let [refreshedPatientMsg] = await getDb().select().from(messages).where(inArray(messages.id, [patientMsg.id]))
    const [refreshedOtherThreadMsg] = await getDb().select().from(messages).where(inArray(messages.id, [otherThreadMsg.id]))

    // markReadByProvider only touches patient-authored messages.
    expect(refreshedProviderMsg.readByProviderAt).toBeNull()
    expect(refreshedPatientMsg.readByProviderAt).not.toBeNull()
    // A different patient's thread is untouched.
    expect(refreshedOtherThreadMsg.readByProviderAt).toBeNull()

    await markReadByPatient(PATIENT_A)
    ;[refreshedProviderMsg] = await getDb().select().from(messages).where(inArray(messages.id, [providerMsg.id]))
    ;[refreshedPatientMsg] = await getDb().select().from(messages).where(inArray(messages.id, [patientMsg.id]))
    expect(refreshedProviderMsg.readByPatientAt).not.toBeNull()
    expect(refreshedPatientMsg.readByPatientAt).toBeNull()
  })
})

describe('getUnreadCountForProvider / getUnreadCountForPatient', () => {
  // getUnreadCountForProvider is a global count across every patient's
  // thread in a database this suite doesn't have exclusive access to (see
  // the shared-dev-DB note in AGENTS.md) -- assert it moves by at least the
  // one row this test adds, not an exact delta, so concurrent activity from
  // another branch/session can't make this flaky.
  it('counts unread messages of the opposite role', async () => {
    const before = await getUnreadCountForProvider()
    await seed(PATIENT_A, 'patient', 'unread by provider')
    const after = await getUnreadCountForProvider()
    expect(after).toBeGreaterThanOrEqual(before + 1)

    const beforePatient = await getUnreadCountForPatient(PATIENT_B)
    await seed(PATIENT_B, 'provider', 'unread by patient')
    const afterPatient = await getUnreadCountForPatient(PATIENT_B)
    expect(afterPatient).toBeGreaterThanOrEqual(beforePatient + 1)
  })
})

describe('listMessageThreads', () => {
  it('surfaces the patient\'s thread with an accurate unread-by-provider count', async () => {
    await seed(PATIENT_A, 'patient', 'thread listing check 1')
    await seed(PATIENT_A, 'patient', 'thread listing check 2')
    await markReadByProvider(PATIENT_A) // clear any pre-existing unread noise from other tests in this file
    const secondUnread = await seed(PATIENT_A, 'patient', 'thread listing check 3 (unread)')

    const threads = await listMessageThreads()
    const mine = threads.find((t) => t.patientId === PATIENT_A)
    expect(mine).toBeTruthy()
    expect(mine!.unreadByProviderCount).toBeGreaterThanOrEqual(1)
    expect(mine!.lastMessagePreview?.id).toBe(secondUnread.id)
  })
})

describe('system messages', () => {
  it('getUnreadCountForPatient counts a system message the same as a provider message', async () => {
    const before = await getUnreadCountForPatient(PATIENT_A)
    await seed(PATIENT_A, 'provider', 'provider notice')
    await seed(PATIENT_A, 'system', 'automated notice')
    const after = await getUnreadCountForPatient(PATIENT_A)
    expect(after).toBe(before + 2)
  })

  it('markReadByPatient sets readByPatientAt on a system message', async () => {
    const systemMsg = await seed(PATIENT_A, 'system', 'automated notice to mark read')
    await markReadByPatient(PATIENT_A)
    const [refreshed] = await getDb().select().from(messages).where(inArray(messages.id, [systemMsg.id]))
    expect(refreshed.readByPatientAt).not.toBeNull()
  })

  it('getUnreadCountForProvider is unchanged by a system message', async () => {
    const before = await getUnreadCountForProvider()
    await seed(PATIENT_A, 'system', 'automated notice not for provider')
    const after = await getUnreadCountForProvider()
    expect(after).toBe(before)
  })

  it('markReadByProvider leaves a system message\'s readByProviderAt null', async () => {
    const systemMsg = await seed(PATIENT_A, 'system', 'automated notice untouched by provider read')
    await markReadByProvider(PATIENT_A)
    const [refreshed] = await getDb().select().from(messages).where(inArray(messages.id, [systemMsg.id]))
    expect(refreshed.readByProviderAt).toBeNull()
  })
})

describe('getPatientDisplayName', () => {
  it('resolves a real seeded patient\'s name', async () => {
    const name = await getPatientDisplayName(PATIENT_A)
    expect(typeof name).toBe('string')
    expect(name!.length).toBeGreaterThan(0)
  })

  it('returns null for an unknown patient id', async () => {
    const name = await getPatientDisplayName('RD-9999')
    expect(name).toBeNull()
  })
})
