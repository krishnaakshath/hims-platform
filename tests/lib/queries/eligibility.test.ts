import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patientTrialScreenings, messages, trials } from '@/db/schema'
import { confirmScreeningSelection, regenerateScreeningCriteria, SYSTEM_SENDER_NAME } from '@/lib/queries/eligibility'
import { listMessagesForPatient } from '@/lib/queries/messages'

const PATIENT = 'RD-0003'

// Every test in this file mutates the real seeded RD-0003 screening row and
// may create real `messages` rows -- restore the screening to its captured
// pre-test state and delete every message this file created, same
// shared-dev-DB discipline as tests/lib/queries/messages.test.ts.
let original: typeof patientTrialScreenings.$inferSelect
const createdMessageIds: number[] = []

beforeEach(async () => {
  const [row] = await getDb().select().from(patientTrialScreenings).where(eq(patientTrialScreenings.patientId, PATIENT))
  original = row
})

afterEach(async () => {
  await getDb()
    .update(patientTrialScreenings)
    .set({
      trialId: original.trialId,
      overallStatus: original.overallStatus,
      selectionConfirmedAt: original.selectionConfirmedAt,
      selectionConfirmedByName: original.selectionConfirmedByName,
      selectionNotifiedAt: original.selectionNotifiedAt,
    })
    .where(eq(patientTrialScreenings.id, original.id))

  if (createdMessageIds.length > 0) {
    await getDb().delete(messages).where(inArray(messages.id, createdMessageIds))
    createdMessageIds.length = 0
  }
})

async function setScreening(fields: Partial<{
  overallStatus: 'green' | 'yellow' | 'red'
  selectionConfirmedAt: Date | null
  selectionConfirmedByName: string | null
  selectionNotifiedAt: Date | null
  trialId: string
}>) {
  await getDb().update(patientTrialScreenings).set(fields).where(eq(patientTrialScreenings.id, original.id))
}

async function getScreening() {
  const [row] = await getDb().select().from(patientTrialScreenings).where(eq(patientTrialScreenings.id, original.id))
  return row
}

describe('confirmScreeningSelection', () => {
  it('confirming a green screening writes all three fields and exactly one system message', async () => {
    await setScreening({ overallStatus: 'green', selectionConfirmedAt: null, selectionConfirmedByName: null, selectionNotifiedAt: null })
    const before = await listMessagesForPatient(PATIENT)

    const result = await confirmScreeningSelection(PATIENT, 'Dr. Rajiv Kunam')
    expect(result.ok).toBe(true)
    if (result.ok) createdMessageIds.push(result.messageId)

    const updated = await getScreening()
    expect(updated.selectionConfirmedAt).toBeInstanceOf(Date)
    expect(updated.selectionNotifiedAt).toBeInstanceOf(Date)
    expect(updated.selectionConfirmedByName).toBe('Dr. Rajiv Kunam')

    const after = await listMessagesForPatient(PATIENT)
    expect(after.length).toBe(before.length + 1)
    const created = after.find((m) => !before.some((b) => b.id === m.id))
    expect(created).toBeTruthy()
    expect(created!.senderRole).toBe('system')
    expect(created!.senderName).toBe(SYSTEM_SENDER_NAME)

    const [trial] = await getDb().select().from(trials).where(eq(trials.id, original.trialId))
    expect(created!.body).toContain(trial.name)
    expect(created!.body).toContain(trial.site)
    expect(created!.body).not.toContain('undefined')
    expect(created!.body).not.toContain('**')
  })

  it('the message is not attributed to the confirming clinician', async () => {
    await setScreening({ overallStatus: 'green', selectionConfirmedAt: null, selectionConfirmedByName: null, selectionNotifiedAt: null })
    const before = await listMessagesForPatient(PATIENT)

    const result = await confirmScreeningSelection(PATIENT, 'Dr. Rajiv Kunam')
    expect(result.ok).toBe(true)
    if (result.ok) createdMessageIds.push(result.messageId)

    const after = await listMessagesForPatient(PATIENT)
    const created = after.find((m) => !before.some((b) => b.id === m.id))
    expect(created!.senderName).toBe(SYSTEM_SENDER_NAME)
    expect(created!.senderName).not.toBe('Dr. Rajiv Kunam')
  })

  it('a yellow screening is rejected and writes nothing', async () => {
    await setScreening({ overallStatus: 'yellow', selectionConfirmedAt: null, selectionConfirmedByName: null, selectionNotifiedAt: null })
    const before = await listMessagesForPatient(PATIENT)

    const result = await confirmScreeningSelection(PATIENT, 'Dr. Rajiv Kunam')
    expect(result).toEqual({ ok: false, reason: 'not_green' })

    const updated = await getScreening()
    expect(updated.selectionConfirmedAt).toBeNull()
    expect(updated.selectionConfirmedByName).toBeNull()
    expect(updated.selectionNotifiedAt).toBeNull()

    const after = await listMessagesForPatient(PATIENT)
    expect(after.length).toBe(before.length)
  })

  it('a red screening is rejected the same way', async () => {
    await setScreening({ overallStatus: 'red', selectionConfirmedAt: null, selectionConfirmedByName: null, selectionNotifiedAt: null })
    const before = await listMessagesForPatient(PATIENT)

    const result = await confirmScreeningSelection(PATIENT, 'Dr. Rajiv Kunam')
    expect(result).toEqual({ ok: false, reason: 'not_green' })

    const updated = await getScreening()
    expect(updated.selectionConfirmedAt).toBeNull()
    expect(updated.selectionConfirmedByName).toBeNull()
    expect(updated.selectionNotifiedAt).toBeNull()

    const after = await listMessagesForPatient(PATIENT)
    expect(after.length).toBe(before.length)
  })

  it('an already-confirmed screening is rejected', async () => {
    await setScreening({ overallStatus: 'green', selectionConfirmedAt: null, selectionConfirmedByName: null, selectionNotifiedAt: null })

    const first = await confirmScreeningSelection(PATIENT, 'Dr. Rajiv Kunam')
    expect(first.ok).toBe(true)
    if (first.ok) createdMessageIds.push(first.messageId)

    const before = await listMessagesForPatient(PATIENT)
    const second = await confirmScreeningSelection(PATIENT, 'Dr. Rajiv Kunam')
    expect(second).toEqual({ ok: false, reason: 'already_confirmed' })
    const after = await listMessagesForPatient(PATIENT)
    expect(after.length).toBe(before.length)
  })

  it('a screening whose trial cannot be resolved aborts before any write', async () => {
    await setScreening({ overallStatus: 'green', selectionConfirmedAt: null, selectionConfirmedByName: null, selectionNotifiedAt: null })
    const before = await listMessagesForPatient(PATIENT)

    // trial_missing defends against a trialId that doesn't resolve to a real
    // trial. patient_trial_screenings.trial_id is FK-constrained, so that
    // state can never actually be written -- this repo's shared dev DB is
    // additive-only/non-destructive by convention (a prior incident is why),
    // so rather than dropping the live FK constraint, stub just the trial
    // lookup (`db.select().from(trials)...`, the exact call site in
    // confirmScreeningSelection) to return no rows for this one call. Every
    // other query on the shared `db` singleton -- including the ones this
    // very test makes via setScreening/getScreening -- passes through to the
    // real database untouched.
    const db = getDb()
    const originalSelect = db.select.bind(db)
    const selectSpy = vi.spyOn(db, 'select').mockImplementation((...args: unknown[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching drizzle's own overloaded, hard-to-narrow select() signature
      const builder = (originalSelect as any)(...args)
      const originalFrom = builder.from.bind(builder)
      builder.from = (table: unknown) => {
        if (table === trials) return { where: () => Promise.resolve([]) }
        return originalFrom(table)
      }
      return builder
    })

    try {
      const result = await confirmScreeningSelection(PATIENT, 'Dr. Rajiv Kunam')
      expect(result).toEqual({ ok: false, reason: 'trial_missing' })

      const updated = await getScreening()
      expect(updated.selectionConfirmedAt).toBeNull()
      expect(updated.selectionConfirmedByName).toBeNull()
      expect(updated.selectionNotifiedAt).toBeNull()
    } finally {
      selectSpy.mockRestore()
    }

    const after = await listMessagesForPatient(PATIENT)
    expect(after.length).toBe(before.length)
  })

  it('a patient with no screening at all returns not_found', async () => {
    const result = await confirmScreeningSelection('RD-9999-nonexistent', 'X')
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('two concurrent confirms produce exactly one message', async () => {
    await setScreening({ overallStatus: 'green', selectionConfirmedAt: null, selectionConfirmedByName: null, selectionNotifiedAt: null })
    const before = await listMessagesForPatient(PATIENT)

    const [r1, r2] = await Promise.all([
      confirmScreeningSelection(PATIENT, 'Dr. Rajiv Kunam'),
      confirmScreeningSelection(PATIENT, 'Dr. Elena Bosch'),
    ])
    const results = [r1, r2]
    const oks = results.filter((r) => r.ok)
    const fails = results.filter((r) => !r.ok)
    expect(oks.length).toBe(1)
    expect(fails.length).toBe(1)
    expect(fails[0]).toEqual({ ok: false, reason: 'already_confirmed' })
    if (oks[0].ok) createdMessageIds.push(oks[0].messageId)

    const after = await listMessagesForPatient(PATIENT)
    const newSystemMessages = after.filter((m) => !before.some((b) => b.id === m.id) && m.senderRole === 'system')
    expect(newSystemMessages.length).toBe(1)
  })
})

describe('regenerateScreeningCriteria verdict-regression clearing', () => {
  it('regenerating a confirmed screening that flips away from green clears the confirmation but not the notification', async () => {
    await setScreening({ overallStatus: 'green', selectionConfirmedAt: null, selectionConfirmedByName: null, selectionNotifiedAt: null })
    const confirmResult = await confirmScreeningSelection(PATIENT, 'Dr. Rajiv Kunam')
    expect(confirmResult.ok).toBe(true)
    if (confirmResult.ok) createdMessageIds.push(confirmResult.messageId)

    // RD-0003 is diagnosed MDD (F32.1), which does not satisfy the ADHD
    // trial's diagnosis criterion (F90.2) -- pointing the screening at it
    // reliably re-evaluates to a non-green verdict without touching the
    // rule engine itself.
    await setScreening({ trialId: 'nct-adhd-demo-01' })
    const verdict = await regenerateScreeningCriteria(PATIENT, original.id, 'nct-adhd-demo-01')
    expect(verdict).not.toBe('green')
    expect(verdict).not.toBeNull()

    const updated = await getScreening()
    expect(updated.selectionConfirmedAt).toBeNull()
    expect(updated.selectionConfirmedByName).toBeNull()
    expect(updated.selectionNotifiedAt).toBeInstanceOf(Date)
  })

  it('regenerating a confirmed screening that stays green leaves the confirmation intact', async () => {
    await setScreening({ overallStatus: 'green', selectionConfirmedAt: null, selectionConfirmedByName: null, selectionNotifiedAt: null })
    const confirmResult = await confirmScreeningSelection(PATIENT, 'Dr. Rajiv Kunam')
    expect(confirmResult.ok).toBe(true)
    if (confirmResult.ok) createdMessageIds.push(confirmResult.messageId)

    const beforeRegen = await getScreening()
    const verdict = await regenerateScreeningCriteria(PATIENT, original.id, original.trialId)
    if (verdict === 'green') {
      const updated = await getScreening()
      expect(updated.selectionConfirmedAt).toEqual(beforeRegen.selectionConfirmedAt)
      expect(updated.selectionConfirmedByName).toEqual(beforeRegen.selectionConfirmedByName)
    }
  })

  it('re-confirming after a regression back to green sends a second, independent notification', async () => {
    await setScreening({ overallStatus: 'green', selectionConfirmedAt: null, selectionConfirmedByName: null, selectionNotifiedAt: null })
    const first = await confirmScreeningSelection(PATIENT, 'Dr. Rajiv Kunam')
    expect(first.ok).toBe(true)
    if (first.ok) createdMessageIds.push(first.messageId)

    const afterFirst = await getScreening()
    const firstNotifiedAt = afterFirst.selectionNotifiedAt!
    expect(firstNotifiedAt).toBeInstanceOf(Date)

    // Exactly the state a verdict regression leaves behind: confirmation
    // cleared, notification timestamp untouched.
    await setScreening({ selectionConfirmedAt: null, selectionConfirmedByName: null, overallStatus: 'green' })

    const before = await listMessagesForPatient(PATIENT)
    const second = await confirmScreeningSelection(PATIENT, 'Dr. Rajiv Kunam')
    expect(second.ok).toBe(true)
    if (second.ok) createdMessageIds.push(second.messageId)

    const after = await listMessagesForPatient(PATIENT)
    const newSystemMessages = after.filter((m) => !before.some((b) => b.id === m.id) && m.senderRole === 'system')
    expect(newSystemMessages.length).toBe(1)

    const finalScreening = await getScreening()
    expect(finalScreening.selectionNotifiedAt!.getTime()).toBeGreaterThan(firstNotifiedAt.getTime())
  })
})
