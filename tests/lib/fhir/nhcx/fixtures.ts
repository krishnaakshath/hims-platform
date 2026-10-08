import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { PayerRef, SnapshotHospital, SnapshotPatient, SnapshotPolicy } from '@/lib/rcm/snapshot'

const DIR = path.join(process.cwd(), 'tests', 'fixtures', 'nhcx')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJson = any
export const fixture = (name: string): AnyJson => JSON.parse(readFileSync(path.join(DIR, `${name}.json`), 'utf8'))
export const allFixtures = (): AnyJson[] => readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')))
export const clone = <T,>(v: T): AnyJson => JSON.parse(JSON.stringify(v))

export const PATIENT: SnapshotPatient = { id: 'RD-0001', uhid: 'UH000000427', name: 'Asha Rao', gender: 'female', dob: '1990-03-12', abhaNumber: null }
export const HOSPITAL: SnapshotHospital = { legalName: 'Test Hospital Pvt Ltd', gstin: '27AAAAA0000A1Z5', stateCode: 'IN-MH', rohiniId: '8900080123456', hfrId: 'IN2710000123' }
export const INSURER: PayerRef = { payerId: 11, name: 'Star Health', kind: 'insurer', irdaiRegistrationNo: '129', nhcxParticipantCode: 'INS1@sbx' }
export const TPA: PayerRef = { payerId: 12, name: 'Medi Assist TPA', kind: 'tpa', irdaiRegistrationNo: null, nhcxParticipantCode: 'TPA1@sbx' }
export const POLICY: SnapshotPolicy = {
  insurer: INSURER, tpa: TPA, policyNumber: 'POL-123', memberId: 'MEM-9', planName: 'Family Health Optima', policyType: 'family_floater',
  holderName: 'Asha Rao', relationship: 'self', validFrom: '2026-04-01', validTo: '2027-03-31', sumInsuredPaise: 50_000_000, corporateName: null,
}
