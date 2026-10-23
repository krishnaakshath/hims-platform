// SP7: the per-patient billing lock every claim, pre-auth, settlement, write-off and invoice-link
// write takes first (then its own row FOR UPDATE). It is SP4's lock, re-exported so the key
// (hashtext('billing:patient:' || id)) can never drift between SP4 and SP7.
// Clinical writers that also lock an encounter take the encounter first (global lock order I1,
// encounters.ts); discharge (WS3 T6): IPD encounter -> this lock -> admission -> room -> coding row.
export { lockPatientBilling } from './charge-capture'
