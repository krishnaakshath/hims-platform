import { getDb } from '@/db/client'
import { appSettings } from '@/db/schema'
import { eq } from 'drizzle-orm'

// Single-row settings table: always operate on row id 1 (created by the seed).
export async function getAppSettings() {
  const [row] = await getDb().select().from(appSettings)
  return row ?? { id: 1, autoClassifyOnComplete: false, practiceName: null, practiceSite: null, practiceTimezone: 'America/Los_Angeles', adminMfaSecretEncrypted: null, adminMfaEnabled: false, adminMfaMethod: 'totp' as const, adminPhone: null, queueDisplayPin: null }
}

// Scoped practice-identity read for the printable prescription page
// (prescriptions plan, Task 5) -- only asks Postgres for the two columns
// the print page actually needs, rather than every column on `app_settings`.
export async function getPracticeIdentity(): Promise<{ practiceName: string | null; practiceSite: string | null }> {
  const [row] = await getDb().select({ practiceName: appSettings.practiceName, practiceSite: appSettings.practiceSite }).from(appSettings)
  return row ?? { practiceName: null, practiceSite: null }
}

// What the Settings page actually renders. The page is a Server Component
// that only ever needs these summarized values, not raw encrypted columns.
export async function getSettingsSummary() {
  const settings = await getAppSettings()
  return {
    autoClassifyOnComplete: settings.autoClassifyOnComplete,
    practiceName: settings.practiceName,
    practiceSite: settings.practiceSite,
    practiceTimezone: settings.practiceTimezone,
    queueDisplayPinConfigured: !!settings.queueDisplayPin,
  }
}

export async function updateAutoClassifySetting(value: boolean) {
  const current = await getAppSettings()
  await getDb().update(appSettings).set({ autoClassifyOnComplete: value }).where(eq(appSettings.id, current.id))
}

export async function updatePracticeInfo(input: { practiceName: string; practiceSite: string; practiceTimezone: string }) {
  const current = await getAppSettings()
  await getDb().update(appSettings).set(input).where(eq(appSettings.id, current.id))
}

export async function getAdminMfaState(): Promise<{ mfaSecretEncrypted: string | null; mfaEnabled: boolean; mfaMethod: 'totp' | 'sms' | 'email'; phone: string | null }> {
  const settings = await getAppSettings()
  return { mfaSecretEncrypted: settings.adminMfaSecretEncrypted, mfaEnabled: settings.adminMfaEnabled, mfaMethod: settings.adminMfaMethod, phone: settings.adminPhone }
}

export async function setAdminMfaSecret(secretEncrypted: string): Promise<void> {
  const current = await getAppSettings()
  await getDb().update(appSettings).set({ adminMfaSecretEncrypted: secretEncrypted }).where(eq(appSettings.id, current.id))
}

export async function enableAdminMfa(): Promise<void> {
  const current = await getAppSettings()
  await getDb().update(appSettings).set({ adminMfaEnabled: true }).where(eq(appSettings.id, current.id))
}

export async function resetAdminMfa(): Promise<void> {
  const current = await getAppSettings()
  await getDb().update(appSettings).set({ adminMfaSecretEncrypted: null, adminMfaEnabled: false }).where(eq(appSettings.id, current.id))
}

export async function getQueueDisplayPin(): Promise<string | null> {
  const settings = await getAppSettings()
  return settings.queueDisplayPin
}

export async function setQueueDisplayPin(pin: string): Promise<void> {
  const current = await getAppSettings()
  await getDb().update(appSettings).set({ queueDisplayPin: pin }).where(eq(appSettings.id, current.id))
}
