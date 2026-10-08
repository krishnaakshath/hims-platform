// SP7: the payer profile form's value shape and blank values (shared by server pages and the client form).
import type { PayerKind } from '@/lib/rcm/constants'
export interface PayerProfileValues {
  kind: PayerKind; shortName: string; irdaiRegistrationNo: string; nhcxParticipantCode: string; defaultChannel: string; portalUrl: string; claimsEmail: string
  empanelmentStatus: string; empanelledFrom: string; empanelledTo: string; agreementReference: string; preauthSlaHours: string; claimSettlementSlaDays: string
  queryResponseDays: string; submissionWindowDays: string; requiresAbha: boolean; requiresPreauthForIpd: boolean; active: boolean; notes: string; gstin: string; stateCode: string
}

export const EMPTY_PROFILE: PayerProfileValues = {
  kind: 'insurer', shortName: '', irdaiRegistrationNo: '', nhcxParticipantCode: '', defaultChannel: 'portal', portalUrl: '', claimsEmail: '', empanelmentStatus: 'pending',
  empanelledFrom: '', empanelledTo: '', agreementReference: '', preauthSlaHours: '1', claimSettlementSlaDays: '30', queryResponseDays: '7', submissionWindowDays: '15',
  requiresAbha: false, requiresPreauthForIpd: true, active: true, notes: '', gstin: '', stateCode: '',
}

