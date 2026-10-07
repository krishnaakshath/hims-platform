// Wave H P2-09: forms, documents, billing, settings and staff components
// surface a failed request in role="alert" with the fixed client message
// (never a 5xx body) and leave the control usable.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { CLIENT_ERROR_MESSAGES, fillAll, mockFetch } from './helpers'

const router = { refresh: vi.fn(), push: vi.fn() }
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/' }))
afterEach(() => { vi.unstubAllGlobals(); router.refresh.mockClear(); router.push.mockClear() })

import { AddCredentialModal } from '@/components/AddCredentialModal'
import { AddStaffMemberModal } from '@/components/AddStaffMemberModal'
import { AutoClassifyToggle } from '@/components/AutoClassifyToggle'
import { ChargesTable } from '@/components/ChargesTable'
import { ConsentDocumentEditor } from '@/components/ConsentDocumentEditor'
import { CreateFormButton } from '@/components/CreateFormButton'
import { EditCredentialModal } from '@/components/EditCredentialModal'
import { EditStaffMemberModal } from '@/components/EditStaffMemberModal'
import { FolderActions } from '@/components/FolderActions'
import { MarkProcessedButton } from '@/components/MarkProcessedButton'
import { NewConsentDocumentButton } from '@/components/NewConsentDocumentButton'
import { NewFolderButton } from '@/components/NewFolderButton'
import { PracticeInfoForm } from '@/components/PracticeInfoForm'
import { QueueDisplayPinForm } from '@/components/QueueDisplayPinForm'
import { RecordSurveyResponseForm } from '@/components/RecordSurveyResponseForm'
import { RestoreTemplateButton } from '@/components/RestoreTemplateButton'
import { SendSurveyButton } from '@/components/SendSurveyButton'
import { TemplateConsentsPanel } from '@/components/TemplateConsentsPanel'
import { MfaMethodPicker } from '@/components/settings/MfaMethodPicker'
import { ProviderProfilesPanel } from '@/components/settings/ProviderProfilesPanel'
import { NotificationPanel } from '@/components/NotificationPanel'

const LEAK = 'TypeError: Cannot read properties of undefined (reading id) at route.ts:42'

// ownMessage: the component keeps its own fixed wording (still never the server's text).
type Case = { name: string; ui: () => ReactElement; before?: () => void; submit: RegExp; fill?: boolean; ownMessage?: boolean }
const CASES: Case[] = [
  { name: 'AddCredentialModal', ui: () => <AddCredentialModal staffMemberId={1} onClose={vi.fn()} />, submit: /^Add Credential$/ },
  { name: 'AddStaffMemberModal', ui: () => <AddStaffMemberModal users={[{ id: 1, name: 'U', email: 'u@x.in', role: 'crc' }] as never} providers={[]} onClose={vi.fn()} />, submit: /^Add Staff Member$/ },
  { name: 'EditCredentialModal', ui: () => <EditCredentialModal credential={{ id: 1, staffMemberId: 1, credentialType: 'MBBS', credentialNumber: '1', expiresOn: '2027-01-01' }} onClose={vi.fn()} />, submit: /^Save Changes$/ },
  { name: 'EditStaffMemberModal', ui: () => <EditStaffMemberModal staffMember={{ id: 1, department: 'OPD', title: 'Nurse', employmentStatus: 'active', terminationDate: null }} onClose={vi.fn()} />, submit: /^Save Changes$/ },
  { name: 'AutoClassifyToggle', ui: () => <AutoClassifyToggle initialEnabled={false} isAdmin />, submit: /^Off$/, fill: false },
  { name: 'ChargesTable', ui: () => <ChargesTable charges={[{ id: 1, patientId: 'RD-1', patientName: 'P', providerName: 'Dr', dateOfService: '2026-10-01', amountCents: 100, status: 'draft' }]} patients={[]} />, submit: /submit|approve|send/i, fill: false },
  { name: 'ConsentDocumentEditor', ui: () => <ConsentDocumentEditor document={{ id: 1, name: 'Consent', bodyText: 'Body', legalReviewStatus: 'draft', signedCount: 0 } as never} />, submit: /^Save$/, fill: false },
  { name: 'CreateFormButton', ui: () => <CreateFormButton folderId={null} />, submit: /form/i, fill: false },
  { name: 'FolderActions delete', ui: () => <FolderActions folder={{ id: 1, name: 'F' }} templateCount={0} />, submit: /^Delete$/, fill: false , ownMessage: true },
  { name: 'MarkProcessedButton', ui: () => <MarkProcessedButton documentId={1} disabled={false} />, submit: /^Mark Processed$/, fill: false },
  { name: 'NewConsentDocumentButton', ui: () => <NewConsentDocumentButton />, before: () => fireEvent.click(screen.getAllByRole('button')[0]), submit: /^Create$/ },
  { name: 'NewFolderButton', ui: () => <NewFolderButton />, before: () => fireEvent.click(screen.getAllByRole('button')[0]), submit: /^Create$/ , ownMessage: true },
  { name: 'PracticeInfoForm', ui: () => <PracticeInfoForm initial={{ practiceName: 'H', practiceSite: 'S', practiceTimezone: 'Asia/Kolkata' }} isAdmin />, submit: /^Save$/ },
  { name: 'QueueDisplayPinForm', ui: () => <QueueDisplayPinForm isAdmin configured={false} />, submit: /^Save$/ },
  { name: 'RecordSurveyResponseForm', ui: () => <RecordSurveyResponseForm reviewId={1} />, submit: /^Record Response$/ },
  { name: 'RestoreTemplateButton', ui: () => <RestoreTemplateButton templateId={1} />, submit: /^Restore$/, fill: false , ownMessage: true },
  { name: 'SendSurveyButton', ui: () => <SendSurveyButton candidates={[{ formSubmissionId: 1, patientId: 'RD-1', patientName: 'P', templateName: 'T', completedDate: null }]} />, before: () => fireEvent.click(screen.getAllByRole('button')[0]), submit: /^Send$/ },
  { name: 'TemplateConsentsPanel', ui: () => <TemplateConsentsPanel templateId={1} attached={[]} allDocuments={[{ id: 2, name: 'Consent A' }]} />, submit: /^Attach$/ },
  { name: 'MfaMethodPicker', ui: () => <MfaMethodPicker email="a@b.co" currentMethod="totp" currentPhone={null} />, before: () => { const email = screen.getAllByRole('radio').find((r) => (r as HTMLInputElement).value === 'email'); if (email) fireEvent.click(email) }, submit: /^Save$/ },
  { name: 'ProviderProfilesPanel', ui: () => <ProviderProfilesPanel providers={[{ id: 1, name: 'Dr A', specialty: 'Gen', credentials: null, departmentId: null, registrationNumber: null, consultationFeePaise: null, isActive: true }] as never} departments={[]} isAdmin />,
    before: () => fireEvent.click(screen.getAllByRole('button', { name: /edit/i })[0]), submit: /^Save$/, fill: false },
]

describe.each(CASES)('$name', (c) => {
  it('shows a 500 in an alert with the fixed message and keeps the control usable', async () => {
    mockFetch(500, { error: LEAK })
    vi.stubGlobal('confirm', () => true)
    render(c.ui())
    c.before?.()
    if (c.fill !== false) await fillAll()
    const button = screen.getAllByRole('button', { name: c.submit }).at(-1)!
    expect(button).toBeEnabled()
    fireEvent.click(button)
    const alert = await screen.findByRole('alert')
    if (c.ownMessage) expect(alert.textContent).toMatch(/could not .* try again/i)
    else expect(alert).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
    expect(alert).not.toHaveTextContent('Cannot read properties')
    await waitFor(() => expect(screen.getAllByRole('button', { name: c.submit }).at(-1)).toBeEnabled())
  })
})

describe('NotificationPanel', () => {
  it('shows a failed load instead of an empty list', async () => {
    mockFetch(500, { error: LEAK })
    render(<NotificationPanel role="admin" />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
    expect(screen.queryByText('No records found.')).toBeNull()
  })
})

import { AssignDocumentPatientControl } from '@/components/AssignDocumentPatientControl'
import { DocumentRowActions } from '@/components/DocumentRowActions'
import { StaffMfaSelfResetForm } from '@/components/settings/StaffMfaSelfResetForm'
import { DepartmentsPanel } from '@/components/settings/DepartmentsPanel'
import { NewChargeModal } from '@/components/NewChargeModal'

describe('more admin components (500 -> alert, no server text)', () => {
  async function expectAlert() {
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toContain('Cannot read properties')
    return alert
  }

  it('AssignDocumentPatientControl', async () => {
    mockFetch(500, { error: LEAK })
    render(<AssignDocumentPatientControl documentId={1} patientId={null} patientName={null} patientDob={null} patientOptions={[{ id: 'RD-1', name: 'P', dob: '2000-01-01' }] as never} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'RD-1' } })
    expect(await expectAlert()).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
  })

  it('DocumentRowActions delete', async () => {
    mockFetch(500, { error: LEAK })
    vi.stubGlobal('confirm', () => true)
    render(<DocumentRowActions documentId={1} documentName="a.pdf" status="new" fileUrl={null} canWrite={false} canDelete />)
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    expect(await expectAlert()).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
  })

  it('StaffMfaSelfResetForm', async () => {
    mockFetch(500, { error: LEAK })
    render(<StaffMfaSelfResetForm email="a@b.co" />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset my MFA' }))
    fireEvent.change(screen.getByLabelText('Confirm your password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reset MFA' }))
    await expectAlert()
    expect(screen.getByRole('button', { name: 'Reset MFA' })).toBeEnabled()
  })

  it('DepartmentsPanel add', async () => {
    mockFetch(500, { error: LEAK })
    render(<DepartmentsPanel departments={[]} isAdmin />)
    await fillAll()
    fireEvent.click(screen.getByRole('button', { name: /Add department/ }))
    await expectAlert()
  })

  it('NewChargeModal', async () => {
    mockFetch(500, { error: LEAK })
    render(<NewChargeModal patients={[{ id: 'RD-1', name: 'P' }]} />)
    fireEvent.click(screen.getByRole('button', { name: '+ New Charge' }))
    await fillAll()
    fireEvent.click(screen.getByRole('button', { name: 'Create Charge (Draft)' }))
    expect(await expectAlert()).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
  })
})

import { VirtualCardPaymentForm } from '@/components/VirtualCardPaymentForm'
import { ReceiveDocumentModal } from '@/components/ReceiveDocumentModal'
import { SignConsentFormAction } from '@/components/SignConsentFormAction'
import { BroadcastWizard } from '@/components/BroadcastWizard'

describe('billing, documents, consent and broadcast components', () => {
  it('VirtualCardPaymentForm shows a 500 with the fixed message', async () => {
    mockFetch(500, { error: LEAK })
    render(<VirtualCardPaymentForm patients={[{ id: 'RD-1', name: 'P' }] as never} />)
    await fillAll()
    fireEvent.click(screen.getByRole('button', { name: 'Process Demo Transaction' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
  })

  it('ReceiveDocumentModal shows a 413/500 failure', async () => {
    mockFetch(500, { error: LEAK })
    const { container } = render(<ReceiveDocumentModal patientOptions={[]} activeAdmissions={[]} onClose={vi.fn()} />)
    const file = document.querySelector('input[type="file"]') ?? container.querySelector('input[type="file"]')
    fireEvent.change(file!, { target: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] } })
    await fillAll()
    fireEvent.click(screen.getByRole('button', { name: 'Receive' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
    expect(screen.getByRole('button', { name: 'Receive' })).toBeEnabled()
  })

  it('SignConsentFormAction shows a 409 message from the route', async () => {
    mockFetch(409, { error: 'This form is already signed' })
    render(<SignConsentFormAction patientId="RD-1" formSubmissionId={4} />)
    fireEvent.change(screen.getByLabelText('Typed signature'), { target: { value: 'Asha' } })
    fireEvent.click(screen.getByLabelText('Attestation'))
    fireEvent.click(screen.getAllByRole('button').at(-1)!)
    expect(await screen.findByRole('alert')).toHaveTextContent('already signed')
  })

  it('BroadcastWizard shows a failed recipient preview', async () => {
    mockFetch(500, { error: LEAK })
    render(<BroadcastWizard trials={[{ id: 't1', condition: 'C' }] as never} />)
    await fillAll()
    const next = screen.queryByRole('button', { name: /next/i })
    if (next) fireEvent.click(next)
    fireEvent.click(screen.getByRole('button', { name: /Preview Recipients/ }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
    expect(alert).not.toHaveTextContent('Cannot read properties')
  })
})

import { FormBuilderEditor } from '@/components/FormBuilderEditor'

describe('FormBuilderEditor', () => {
  it('shows a failed save in an alert', async () => {
    mockFetch(500, { error: LEAK })
    render(<FormBuilderEditor templateId={1} initialName="F" initialCategory="C" initialDiagnosisTag="D" initialFolderId={null} initialIsActive folders={[]} attachedConsents={[]} allConsentDocuments={[]} patients={[]}
      initialQuestions={[{ id: 'q1', label: 'Name', type: 'text', hipaaSensitive: false, required: true }]} />)
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'Renamed form' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Form' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
    expect(screen.getByRole('button', { name: 'Save Form' })).toBeEnabled()
  })
})
