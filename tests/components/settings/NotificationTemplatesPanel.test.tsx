// Foundations T8: Settings → Notifications (admin chooses channels per template).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

import { NotificationTemplatesPanel } from '@/components/settings/NotificationTemplatesPanel'

afterEach(() => vi.unstubAllGlobals())

const configs = [
  { templateKey: 'appointment_reminder' as const, saved: false, channels: ['sms' as const, 'whatsapp' as const], dltTemplateId: null, whatsappTemplateName: null },
  { templateKey: 'form_sent' as const, saved: true, channels: ['email' as const], dltTemplateId: '1107', whatsappTemplateName: 'form_v1' },
]
const configured = { sms: false, whatsapp: true, email: false, in_app: false }

describe('NotificationTemplatesPanel', () => {
  it('shows one row per template with channel checkboxes and which channels are set up', () => {
    render(<NotificationTemplatesPanel configs={configs} configured={configured} />)
    const row = screen.getByRole('row', { name: /appointment reminder/i })
    expect(within(row).getByRole('checkbox', { name: /appointment reminder: sms/i })).toBeChecked()
    expect(within(row).getByRole('checkbox', { name: /appointment reminder: email/i })).not.toBeChecked()
    expect(screen.getByText(/SMS: not set up/i)).toBeInTheDocument()
    expect(screen.getByText(/WhatsApp: set up/i)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /form sent: dlt template id/i })).toHaveValue('1107')
  })

  it('saves a row with the chosen channels and provider ids', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<NotificationTemplatesPanel configs={configs} configured={configured} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /appointment reminder: email/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /appointment reminder: sms/i }))
    fireEvent.change(screen.getByRole('textbox', { name: /appointment reminder: whatsapp template name/i }), { target: { value: 'reminder_v1' } })
    fireEvent.click(screen.getByRole('button', { name: /save appointment reminder/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/notification-templates', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ templateKey: 'appointment_reminder', channels: ['whatsapp', 'email'], dltTemplateId: null, whatsappTemplateName: 'reminder_v1' }),
    }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/saved/i))
  })

  it('announces a failed save', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid payload' }), { status: 400 })))
    render(<NotificationTemplatesPanel configs={configs} configured={configured} />)
    fireEvent.click(screen.getByRole('button', { name: /save form sent/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  })
})
