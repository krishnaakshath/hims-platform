import Link from 'next/link'
import { redirect } from 'next/navigation'
import { MessageSquare } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listMessageThreads, listMessagesForPatient, markReadByProvider } from '@/lib/queries/messages'
import { PatientAvatar } from '@/components/PatientAvatar'
import { MessageThreadView } from '@/components/MessageThreadView'
import { MessageComposer } from '@/components/MessageComposer'

const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'
const HEADING = 'mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

// LeftNav.tsx:81 -- crc/pi/admin/pharmacy, not frontdesk/billing/labs. Jamie
// Ruiz the CRC coordinates patient communication in real clinics too, not
// only the PI, but front desk/billing/labs have no part in it.
export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ patientId?: string }> }) {
  const session = await requireSessionOrRedirect()
  if (!['crc', 'pi', 'admin', 'pharmacy'].includes(session.role)) redirect('/')
  const { patientId: requestedPatientId } = await searchParams

  const threads = await listMessageThreads()
  const selectedPatientId = requestedPatientId ?? threads[0]?.patientId ?? null

  const selectedThread = selectedPatientId ? await listMessagesForPatient(selectedPatientId) : []
  if (selectedPatientId) {
    await markReadByProvider(selectedPatientId)
    await logAudit(session, 'viewed patient messages', selectedPatientId)
  }

  const selectedThreadMeta = threads.find((t) => t.patientId === selectedPatientId)
  const selectedPatientName = selectedThreadMeta?.patientName ?? selectedPatientId

  return (
    <div>
      <div className="mb-6 flex items-center gap-4 rounded-md border border-border bg-card p-5 shadow-none">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
          <MessageSquare className="h-6 w-6" />
        </span>
        <div>
          <h1 className="text-xl font-bold text-foreground">Messages</h1>
          <p className="text-sm text-muted-foreground">Secure messages between staff and patients.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
        <section className={SECTION}>
          <h2 className={HEADING}>Conversations</h2>
          {threads.length === 0 ? (
            <p className="text-sm text-muted-foreground">No patient messages yet.</p>
          ) : (
            <ul className="space-y-1">
              {threads.map((t) => (
                <li key={t.patientId}>
                  <Link
                    href={`/messages?patientId=${t.patientId}`}
                    className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                      t.patientId === selectedPatientId ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-secondary'
                    }`}
                  >
                    <PatientAvatar name={t.patientName} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{t.patientName}</span>
                        {t.unreadByProviderCount > 0 && (
                          <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold text-accent-foreground">
                            {t.unreadByProviderCount}
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {t.lastMessagePreview
                          ? `${t.lastMessagePreview.senderRole === 'provider' ? 'You: ' : t.lastMessagePreview.senderRole === 'system' ? 'Automated: ' : ''}${t.lastMessagePreview.body}`
                          : ''}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={`${SECTION} flex min-h-[420px] flex-col`}>
          {!selectedPatientId ? (
            <p className="text-sm text-muted-foreground">Select a conversation to view messages.</p>
          ) : (
            <>
              <div className="mb-3 flex items-center gap-3 border-b border-border pb-3">
                <PatientAvatar name={selectedPatientName ?? selectedPatientId} />
                <div>
                  <p className="text-sm font-semibold text-foreground">{selectedPatientName}</p>
                  <p className="font-mono text-xs text-muted-foreground">Patient ID {selectedPatientId}</p>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto pr-1">
                <MessageThreadView messages={selectedThread} viewerRole="provider" />
              </div>
              <div className="mt-4 border-t border-border pt-4">
                <MessageComposer patientId={selectedPatientId} viewerRole="provider" />
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
