// /rcm/payers/[id]: one payer's profile, contacts, TPA network and required documents (RCM_ROLES).
import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { parseId } from '@/lib/http'
import { INSURER_SIDE_KINDS } from '@/lib/rcm/constants'
import { getRcmPayer, listRcmPayers } from '@/lib/queries/rcm-payers'
import { PayerProfileForm } from '@/components/rcm/PayerProfileForm'
import { EMPTY_PROFILE, type PayerProfileValues } from '@/components/rcm/payer-profile-values'
import { PayerContactsForm } from '@/components/rcm/PayerContactsForm'
import { PayerNetworkForm } from '@/components/rcm/PayerNetworkForm'
import { DocumentRequirementsForm } from '@/components/rcm/DocumentRequirementsForm'

export default async function PayerPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!RCM_ROLES.includes(session.role)) redirect('/')

  const id = parseId((await params).id)
  if (id === null) notFound()
  const payer = await getRcmPayer(id)
  if (!payer) notFound()
  const p = payer.profile
  const initial: PayerProfileValues = p === null ? { ...EMPTY_PROFILE, gstin: payer.gstin ?? '', stateCode: payer.stateCode ?? '' } : {
    kind: p.kind, shortName: p.shortName ?? '', irdaiRegistrationNo: p.irdaiRegistrationNo ?? '', nhcxParticipantCode: p.nhcxParticipantCode ?? '', defaultChannel: p.defaultChannel,
    portalUrl: p.portalUrl ?? '', claimsEmail: p.claimsEmail ?? '', empanelmentStatus: p.empanelmentStatus, empanelledFrom: p.empanelledFrom ?? '', empanelledTo: p.empanelledTo ?? '',
    agreementReference: p.agreementReference ?? '', preauthSlaHours: String(p.preauthSlaHours), claimSettlementSlaDays: String(p.claimSettlementSlaDays),
    queryResponseDays: String(p.queryResponseDays), submissionWindowDays: String(p.submissionWindowDays), requiresAbha: p.requiresAbha, requiresPreauthForIpd: p.requiresPreauthForIpd,
    active: p.active, notes: p.notes ?? '', gstin: payer.gstin ?? '', stateCode: payer.stateCode ?? '',
  }
  const insurerSide = p !== null && INSURER_SIDE_KINDS.includes(p.kind)
  const tpas = insurerSide ? (await listRcmPayers({ kind: 'tpa' })).map((t) => ({ payerId: t.payerId, name: t.name })) : []
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-foreground">{payer.name} <span className="text-sm font-normal text-muted-foreground">{payer.code}</span></h1>
      {p === null && <p className="text-sm text-amber-700">This payer has no insurer/TPA profile yet. Save one to use it on policies and claims.</p>}
      <PayerProfileForm payerId={id} initial={initial} />
      {p !== null && <PayerContactsForm payerId={id} initial={payer.contacts.map((c) => ({ name: c.name, designation: c.designation ?? '', phone: c.phone ?? '', email: c.email ?? '', isEscalation: c.isEscalation }))} />}
      {insurerSide && <PayerNetworkForm payerId={id} tpas={tpas} selected={payer.tpaIds} />}
      {p !== null && <DocumentRequirementsForm payerId={id} overrides={payer.requirements.map((r) => ({ claimType: r.claimType, documentKind: r.documentKind, required: r.required }))} />}
    </div>
  )
}
