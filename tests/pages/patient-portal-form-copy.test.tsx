// WS7 T3: the patient's signed copy of a completed form, and the intake page's
// portal link. The copy query is scoped to the SESSION patient: another
// patient's submission is a 404 with no audit row. The intake page decides
// "portal-linked" from the patient session alone, never from the URL.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const h = vi.hoisted(() => ({
  sessionPatient: 'RD-0001' as string | null,
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))
vi.mock('next/navigation', () => ({ redirect: (u: string) => h.redirect(u), notFound: () => { throw new Error('NEXT_NOT_FOUND') }, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/lib/patient-session', () => ({
  requirePatientSessionOrRedirect: vi.fn(async () => {
    if (!h.sessionPatient) h.redirect('/patient-portal/login')
    return { patientId: h.sessionPatient }
  }),
  getPatientSession: vi.fn(async () => (h.sessionPatient ? { patientId: h.sessionPatient } : null)),
}))
vi.mock('@/lib/queries/policy-documents', () => ({ hasAcceptedCurrentPolicies: vi.fn(async () => true) }))
vi.mock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/patient-portal-records', () => ({ getPortalFormCopy: vi.fn(async () => null) }))
vi.mock('@/lib/queries/intake-portal', () => ({
  getIntakePortalData: vi.fn(),
  getIntakeSubmissionRef: vi.fn(),
}))
vi.mock('@/lib/queries/patient-portal', () => ({ getPatientPortalData: vi.fn() }))
vi.mock('@/components/SignConsentFormAction', () => ({ SignConsentFormAction: () => null }))
vi.mock('@/components/IntakePortalForm', () => ({
  IntakePortalForm: ({ signedCopyHref }: { signedCopyHref?: string | null }) => <p data-testid="form">copy={String(signedCopyHref ?? null)}</p>,
  PortalLinks: ({ signedCopyHref }: { signedCopyHref: string }) => <><a href="/patient-portal">Back to your portal</a><a href={signedCopyHref}>View signed copy</a></>,
}))

import FormCopyPage from '@/app/patient-portal/documents/forms/[submissionId]/page'
import IntakePage from '@/app/intake/[token]/page'
import { getPortalFormCopy, type PortalFormCopy } from '@/lib/queries/patient-portal-records'
import { getIntakePortalData, getIntakeSubmissionRef } from '@/lib/queries/intake-portal'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import FormsPage from '@/app/patient-portal/(authenticated)/forms/page'
import { getPatientPortalData } from '@/lib/queries/patient-portal'

// Opened from the portal forms list: no query string -- the language comes from the stored submission.
const props = (submissionId: string, search: Record<string, string> = {}) => ({ params: Promise.resolve({ submissionId }), searchParams: Promise.resolve(search) })

const COPY: PortalFormCopy = {
  submissionId: 9,
  templateName: 'General consent',
  completedDate: new Date('2026-10-20T06:30:00Z'),
  patientName: 'Maria Alvarez',
  uhid: 'UH000000011',
  languages: ['en', 'hi'],
  language: 'en',
  questions: [
    { id: 'smoker', label: 'Do you smoke?', type: 'select', options: ['Yes', 'No'], hipaaSensitive: false, required: true, i18n: { hi: { label: 'क्या आप धूम्रपान करते हैं?', options: ['हाँ', 'नहीं'] } } },
    { id: 'perDay', label: 'Cigarettes per day', type: 'number', hipaaSensitive: false, required: true, visibleIf: { questionId: 'smoker', equals: 'Yes' } },
    { id: 'scan', label: 'Referral letter', type: 'file', hipaaSensitive: false, required: false },
    { id: 'sign', label: 'Signature', type: 'signature', hipaaSensitive: false, required: true },
  ],
  answers: { smoker: 'Yes', perDay: '4', scan: 'doc:42', sign: 'Maria Alvarez' },
  consents: [{ formSubmissionConsentId: 3, name: 'Consent to treatment', renderedText: 'I agree to be treated.', signedAt: new Date('2026-10-20T06:00:00Z'), signerTypedName: 'Maria Alvarez' }],
}

beforeEach(() => {
  h.sessionPatient = 'RD-0001'
  h.redirect.mockClear()
  vi.mocked(getPortalFormCopy).mockReset().mockResolvedValue(null)
  vi.mocked(logPatientPortalAction).mockClear()
})

describe('signed form copy page', () => {
  it('no patient session -> portal login before any read', async () => {
    h.sessionPatient = null
    await expect(FormCopyPage(props('9'))).rejects.toThrow('NEXT_REDIRECT:/patient-portal/login')
    expect(getPortalFormCopy).not.toHaveBeenCalled()
  })

  it('a malformed id is a 404 with no read', async () => {
    await expect(FormCopyPage(props('abc'))).rejects.toThrow('NEXT_NOT_FOUND')
    expect(getPortalFormCopy).not.toHaveBeenCalled()
  })

  it('another patient\'s submission (the scoped query finds nothing) is a 404 and is not audited', async () => {
    await expect(FormCopyPage(props('77'))).rejects.toThrow('NEXT_NOT_FOUND')
    expect(vi.mocked(getPortalFormCopy).mock.calls[0]).toEqual(['RD-0001', 77])
    expect(logPatientPortalAction).not.toHaveBeenCalled()
  })

  it('renders answers, consents with signature and IST time, the UHID and no chart id; audits the view', async () => {
    vi.mocked(getPortalFormCopy).mockResolvedValue(COPY)
    render(await FormCopyPage(props('9')))
    expect(screen.getByText('General consent')).toBeInTheDocument()
    expect(screen.getByText('UH000000011')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('RD-0001')
    expect(screen.getByText('Do you smoke?')).toBeInTheDocument()
    expect(screen.getByText('Yes')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('Document uploaded')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('doc:42')
    expect(screen.getByText('Consent to treatment')).toBeInTheDocument()
    expect(screen.getByText('I agree to be treated.')).toBeInTheDocument()
    expect(screen.getByText('Signed by Maria Alvarez on 20 Oct 2026, 11:30 am IST')).toBeInTheDocument()
    expect(logPatientPortalAction).toHaveBeenCalledWith('viewed signed form copy', 'RD-0001', 'submission=9')
  })

  it('a Hindi submission opened from the portal list renders in Hindi, English where untranslated', async () => {
    vi.mocked(getPortalFormCopy).mockResolvedValue({ ...COPY, language: 'hi' })
    render(await FormCopyPage(props('9')))
    expect(screen.getByText('क्या आप धूम्रपान करते हैं?')).toBeInTheDocument()
    expect(screen.getByText('हाँ')).toBeInTheDocument()
    expect(screen.getByText('Cigarettes per day')).toBeInTheDocument()
  })

  it('the URL cannot change the language: an English submission stays English whatever ?lang= says', async () => {
    vi.mocked(getPortalFormCopy).mockResolvedValue(COPY)
    render(await FormCopyPage(props('9', { lang: 'hi' })))
    expect(screen.getByText('Do you smoke?')).toBeInTheDocument()
  })
})

describe('intake page: portal link from the patient session only', () => {
  const ACTIVE = { state: 'active' as const, templateName: 'General consent', questions: [], existingAnswers: {}, autofill: {}, consents: [], languages: ['en' as const] }
  const intakeProps = (search: Record<string, string> = {}) => ({ params: Promise.resolve({ token: 'tok' }), searchParams: Promise.resolve(search) })

  beforeEach(() => {
    vi.mocked(getIntakePortalData).mockResolvedValue(ACTIVE)
    vi.mocked(getIntakeSubmissionRef).mockResolvedValue({ submissionId: 9, patientId: 'RD-0001' })
  })

  it('a session for the submission\'s patient links the signed copy', async () => {
    render(await IntakePage(intakeProps()))
    expect(screen.getByTestId('form')).toHaveTextContent('copy=/patient-portal/documents/forms/9')
  })

  it('no session, or another patient\'s session, gives no links -- whatever the query string says', async () => {
    h.sessionPatient = null
    const { unmount } = render(await IntakePage(intakeProps({ portal: '1', portalLinked: 'true' })))
    expect(screen.getByTestId('form')).toHaveTextContent('copy=null')
    unmount()
    h.sessionPatient = 'RD-0002'
    render(await IntakePage(intakeProps()))
    expect(screen.getByTestId('form')).toHaveTextContent('copy=null')
  })

  it('an already-submitted form still offers the portal links to its own patient', async () => {
    vi.mocked(getIntakePortalData).mockResolvedValue({ state: 'completed' })
    render(await IntakePage(intakeProps()))
    expect(screen.getByText('Already submitted')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View signed copy' })).toHaveAttribute('href', '/patient-portal/documents/forms/9')
    expect(screen.getByRole('link', { name: 'Back to your portal' })).toHaveAttribute('href', '/patient-portal')
  })
})

describe('portal forms list', () => {
  it('a completed form links to its signed copy; an open one links to the form instead', async () => {
    vi.mocked(getPatientPortalData).mockResolvedValue({ forms: [
      { id: 9, status: 'completed', sentDate: new Date('2026-10-01T05:00:00Z'), accessToken: 'tok-a', templateName: 'General consent', category: 'Consent Forms', hasAttachedConsents: true },
      { id: 10, status: 'sent', sentDate: new Date('2026-10-02T05:00:00Z'), accessToken: 'tok-b', templateName: 'Admission form', category: 'Admission', hasAttachedConsents: false },
    ] } as never)
    render(await FormsPage())
    const links = screen.getAllByRole('link', { name: /View signed copy/ })
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/patient-portal/documents/forms/9'])
    expect(screen.getByRole('link', { name: /Start/ })).toHaveAttribute('href', '/intake/tok-b')
  })
})
