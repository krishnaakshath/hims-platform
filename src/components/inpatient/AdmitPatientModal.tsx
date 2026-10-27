'use client'
// WS3 T3: the admission dialog (spec 3.1), opened from check-in ("Inpatient") and the bed board
// ("Admit here"). Its beds, payers and deposit hint come from
// GET /api/inpatient/admissions/form-context; it posts POST /api/inpatient/admissions, which
// re-checks every rule. The success screen shows the stay (UHID, bed, deposit link), never a token.
import { useEffect, useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { PickedPatient } from '@/components/PatientPicker'
import { CodePicker } from '@/components/coding/CodePicker'
import type { CodeSearchHit } from '@/components/coding/codingApi'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import { istDateOf } from '@/lib/india-time'
import { OVERRIDE_REASON_MIN, admissionTypeLabel, type WardGenderConflict } from '@/lib/inpatient/admission-rules'
import type { AdmitPatientRequest } from '@/lib/inpatient/validation'
import { formatPaise, formatRupeesWhole, parseRupeesToPaise } from '@/lib/money'
import { VISIT_REASON_MAX_LENGTH } from '@/lib/notification-templates'
import type { AdmissionFormContext } from '@/lib/queries/admission-form-context'
import { CoverageBadge } from '@/components/insurance/CoverageBadge'
import type { CoverageVerdict } from '@/lib/insurance/coverage'

type AdmissionType = AdmitPatientRequest['admissionType']
type Bed = AdmissionFormContext['beds'][number]
interface Admitted { uhid: string | null; roomLabel: string; depositRequiredPaise: number; cashDeskHref?: string; coverage?: CoverageVerdict; eligibility?: { started: boolean; message?: string } }
type CoverMode = 'cashless' | 'reimbursement'

const ADMISSION_TYPES: AdmissionType[] = ['elective', 'emergency', 'transfer_in']
const FIELD = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
const SECTION = 'space-y-2 rounded-md border border-border p-3'
const LEGEND = 'px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

const money = (paise: number) => (paise % 100 === 0 ? formatRupeesWhole(paise / 100) : formatPaise(paise))
const rupeesInput = (paise: number) => (paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2))
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const withDoctor = (name: string) => (/^dr\b/i.test(name) ? name : `Dr ${name}`)

function conflictText(conflict: WardGenderConflict, gender: AdmissionFormContext['patient']['gender'], ward: Bed['genderRestriction']): string {
  if (conflict === 'opposite_sex' && gender) return `${cap(gender)} patient, ${ward} ward`
  return `Patient's gender is ${gender && gender !== 'unknown' ? gender : 'not recorded'}, ${ward} ward`
}

function bedOption(b: Bed): string {
  return [b.label, b.roomCategoryName, b.tariffPaise !== null ? `${money(b.tariffPaise)}/day` : null, b.conflict ? 'gender restricted' : null]
    .filter(Boolean).join(' · ')
}

export function AdmitPatientModal({ patient, initialRoomId = null, providers, onClose }: {
  patient: PickedPatient
  initialRoomId?: number | null
  providers: { id: number; name: string }[]
  onClose: () => void
}) {
  const router = useRouter()
  const id = useId()
  const [ctx, setCtx] = useState<AdmissionFormContext | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [admissionType, setAdmissionType] = useState<AdmissionType>('elective')
  const [providerId, setProviderId] = useState<number | ''>(providers.length === 1 ? providers[0].id : '')
  const [reason, setReason] = useState('')
  const [code, setCode] = useState<CodeSearchHit | null>(null)
  const [typed, setTyped] = useState(false)
  const [diagnosisText, setDiagnosisText] = useState('')
  const [stayDays, setStayDays] = useState('1')
  const [roomId, setRoomId] = useState<number | ''>('')
  const [overrideReason, setOverrideReason] = useState('')
  const [attendant, setAttendant] = useState({ name: '', relationship: '', phone: '' })
  const [policyId, setPolicyId] = useState<number | ''>('')
  const [preauthId, setPreauthId] = useState<number | ''>('')
  const [deposit, setDeposit] = useState('')
  const [coverMode, setCoverMode] = useState<CoverMode>('cashless')
  // WS12 T9: each policy's verdict at IPD admission (a cashless stay whose cover blocks is refused
  // unless it is an emergency; the route re-checks). Null when the cover cannot be read.
  const [verdicts, setVerdicts] = useState<Map<number, CoverageVerdict> | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openOpdAsk, setOpenOpdAsk] = useState(false)
  const [admitted, setAdmitted] = useState<Admitted | null>(null)

  useEffect(() => {
    let live = true
    void fetchJson<AdmissionFormContext>(`/api/inpatient/admissions/form-context?patientId=${encodeURIComponent(patient.id)}`).then((r) => {
      if (!live) return
      if (!r.ok) { setLoadError(r.error); return }
      setCtx(r.data)
      setDeposit(rupeesInput(r.data.depositThresholdPaise))
      if (initialRoomId !== null && r.data.beds.some((b) => b.id === initialRoomId)) setRoomId(initialRoomId)
    })
    return () => { live = false }
  }, [patient.id, initialRoomId])

  useEffect(() => {
    let live = true
    void fetchJson<{ policies: { policyId: number; verdict: CoverageVerdict }[] }>(`/api/patients/${encodeURIComponent(patient.id)}/coverage?context=ipd_admission`).then((r) => {
      if (live && r.ok && Array.isArray(r.data?.policies)) setVerdicts(new Map(r.data.policies.map((p) => [p.policyId, p.verdict])))
    })
    return () => { live = false }
  }, [patient.id])

  /** R12: the deposit default follows the payer: the self-pay threshold, nothing for an insured stay. */
  function choosePayer(next: number | '') {
    setPolicyId(next)
    setPreauthId('')
    setCoverMode('cashless')
    if (ctx) setDeposit(rupeesInput(next === '' ? ctx.depositThresholdPaise : 0))
  }

  const bed = ctx?.beds.find((b) => b.id === roomId) ?? null
  const needsOverride = bed?.conflict != null
  const attendantFilled = [attendant.name, attendant.relationship, attendant.phone].map((s) => s.trim())
  const attendantState = attendantFilled.every((s) => s === '') ? 'none' : attendantFilled.every((s) => s !== '') ? 'complete' : 'partial'
  const depositPaise = parseRupeesToPaise(deposit)
  const days = /^\d+$/.test(stayDays.trim()) ? Number(stayDays.trim()) : NaN
  const preauthChoices = ctx && policyId !== '' ? ctx.preauths.filter((p) => p.policyId === policyId) : []
  const diagnosisOk = typed ? diagnosisText.trim().length >= 3 : code !== null
  const verdict = policyId !== '' ? verdicts?.get(policyId) ?? null : null
  const emergency = admissionType === 'emergency'
  const coverBlocks = policyId !== '' && coverMode === 'cashless' && verdict?.severity === 'block' && !emergency

  const valid = ctx !== null && ctx.activeAdmissionId === null && providerId !== '' && reason.trim() !== '' && diagnosisOk
    && Number.isInteger(days) && days >= 1 && days <= 365 && bed !== null
    && (!needsOverride || overrideReason.trim().length >= OVERRIDE_REASON_MIN)
    && attendantState !== 'partial' && depositPaise !== null && !coverBlocks

  function body(openOpdVisit: AdmitPatientRequest['openOpdVisit']): AdmitPatientRequest {
    return {
      patientId: patient.id,
      attendingProviderId: providerId as number,
      roomId: roomId as number,
      admissionType,
      reason: reason.trim(),
      provisionalDiagnosis: typed ? { text: diagnosisText.trim() } : { codeId: code!.id },
      expectedStayDays: days,
      attendant: attendantState === 'complete' ? { name: attendantFilled[0], relationship: attendantFilled[1], phone: attendantFilled[2] } : null,
      policyId: policyId === '' ? null : policyId,
      preauthId: policyId === '' || preauthId === '' ? null : preauthId,
      coverageMode: policyId === '' ? 'self_pay' : coverMode,
      depositRequiredPaise: depositPaise ?? 0,
      wardGenderOverrideReason: needsOverride ? overrideReason.trim() : null,
      openOpdVisit,
    }
  }

  async function submit(openOpdVisit: AdmitPatientRequest['openOpdVisit'] = null) {
    if (!valid) return
    setSubmitting(true)
    setError(null)
    const res = await sendJson<Admitted>('/api/inpatient/admissions', 'POST', body(openOpdVisit))
    setSubmitting(false)
    if (res.ok) {
      setOpenOpdAsk(false)
      setAdmitted(res.data)
      router.refresh()
      return
    }
    const refusal = (res.body as { code?: unknown } | undefined)?.code
    if (refusal === 'open_opd_visit') { setOpenOpdAsk(true); return }
    setOpenOpdAsk(false)
    setError(res.error)
  }

  if (admitted) {
    return (
      <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Patient admitted</DialogTitle></DialogHeader>
          <div className="space-y-3 rounded-md border p-4 text-center" role="status">
            <p className="text-lg font-semibold text-foreground">{patient.name}</p>
            <p className="font-mono text-xs text-muted-foreground">{admitted.uhid ? `UHID ${admitted.uhid}` : 'UHID not issued yet'}</p>
            <hr className="border-border" />
            <p className="text-sm text-muted-foreground">Bed</p>
            <p className="text-lg font-semibold text-foreground">{admitted.roomLabel}</p>
            {admitted.coverage && <p className="flex flex-wrap items-center justify-center gap-2 text-sm"><span className="text-muted-foreground">Insurance</span><CoverageBadge verdict={admitted.coverage} /></p>}
            {admitted.eligibility?.message && <p className="text-xs text-muted-foreground">{admitted.eligibility.message}</p>}
            {admitted.depositRequiredPaise > 0 && (
              <p className="text-sm text-muted-foreground">Deposit to collect: <span className="font-medium text-foreground">{money(admitted.depositRequiredPaise)}</span></p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            {admitted.cashDeskHref && (
              <a href={admitted.cashDeskHref} className="inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary">
                Collect deposit
              </a>
            )}
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  const label = (suffix: string) => `${id}-${suffix}`
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader><DialogTitle>Admit patient</DialogTitle></DialogHeader>
        <p className="text-sm text-foreground">
          <span className="font-medium">{patient.name}</span>
          {patient.uhid && <span className="font-mono text-xs text-muted-foreground"> · UHID {patient.uhid}</span>}
        </p>

        {!ctx && !loadError && <p className="text-sm text-muted-foreground" role="status">Loading the admission form…</p>}
        {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
        {ctx && ctx.activeAdmissionId !== null && (
          <p role="alert" className="text-sm text-warning">This patient is already admitted. Use Transfer to move them to a different bed.</p>
        )}

        {ctx && ctx.activeAdmissionId === null && (
          <div className="space-y-3">
            <fieldset className={SECTION}>
              <legend className={LEGEND}>Admission</legend>
              <select value={admissionType} onChange={(e) => setAdmissionType(e.target.value as AdmissionType)} aria-label="Admission type" className={FIELD}>
                {ADMISSION_TYPES.map((t) => <option key={t} value={t}>{admissionTypeLabel(t)}</option>)}
              </select>
              <select value={providerId} onChange={(e) => setProviderId(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Attending doctor" className={FIELD}>
                <option value="">Attending doctor…</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for admission" aria-label="Reason for admission" maxLength={VISIT_REASON_MAX_LENGTH} className={FIELD} />
              <div className="space-y-1">
                {code && !typed ? (
                  <p className="flex items-center justify-between gap-2 text-sm">
                    <span><span className="font-mono text-xs font-semibold">{code.code}</span> {code.display}</span>
                    <Button type="button" variant="outline" size="sm" onClick={() => setCode(null)}>Change</Button>
                  </p>
                ) : typed ? (
                  <input value={diagnosisText} onChange={(e) => setDiagnosisText(e.target.value)} placeholder="Provisional diagnosis" aria-label="Provisional diagnosis" maxLength={200} className={FIELD} />
                ) : (
                  <CodePicker kinds={['icd10']} onDate={istDateOf(new Date())} onPick={setCode} label="Provisional diagnosis (ICD-10)" />
                )}
                <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => { setTyped(!typed); setCode(null) }}>
                  {typed ? 'Search ICD-10 instead' : 'Type instead'}
                </button>
              </div>
              <label htmlFor={label('stay')} className="flex items-center gap-2 text-sm">
                Expected stay (days)
                <input id={label('stay')} value={stayDays} onChange={(e) => setStayDays(e.target.value)} inputMode="numeric" className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm" />
              </label>
            </fieldset>

            <fieldset className={SECTION}>
              <legend className={LEGEND}>Bed</legend>
              <select value={roomId} onChange={(e) => { setRoomId(e.target.value === '' ? '' : Number(e.target.value)); setOverrideReason('') }} aria-label="Bed" className={FIELD}>
                <option value="">{ctx.beds.length === 0 ? 'No free beds' : 'Choose a free bed…'}</option>
                {ctx.beds.map((b) => <option key={b.id} value={b.id}>{bedOption(b)}</option>)}
              </select>
              {bed?.conflict && (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-warning">{conflictText(bed.conflict, ctx.patient.gender, bed.genderRestriction)}</p>
                  <textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} aria-label="Override reason" maxLength={300} rows={2}
                    placeholder={`Why this bed? (at least ${OVERRIDE_REASON_MIN} characters)`} className={FIELD} />
                </div>
              )}
            </fieldset>

            <fieldset className={SECTION}>
              <legend className={LEGEND}>Attendant (optional)</legend>
              <input value={attendant.name} onChange={(e) => setAttendant({ ...attendant, name: e.target.value })} placeholder="Name" aria-label="Attendant name" maxLength={100} className={FIELD} />
              <div className="flex gap-2">
                <input value={attendant.relationship} onChange={(e) => setAttendant({ ...attendant, relationship: e.target.value })} placeholder="Relationship" aria-label="Attendant relationship" maxLength={40} className={FIELD} />
                <input value={attendant.phone} onChange={(e) => setAttendant({ ...attendant, phone: e.target.value })} placeholder="Mobile" aria-label="Attendant phone" inputMode="tel" maxLength={40} className={FIELD} />
              </div>
              {attendantState === 'partial' && <p className="text-xs text-warning">Give the attendant&apos;s name, relationship and mobile, or leave all three empty.</p>}
            </fieldset>

            <fieldset className={SECTION}>
              <legend className={LEGEND}>Payer</legend>
              <select value={policyId} onChange={(e) => choosePayer(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Payer" className={FIELD}>
                <option value="">Self-pay</option>
                {ctx.policies.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              {policyId !== '' && (
                <select value={coverMode} onChange={(e) => setCoverMode(e.target.value as CoverMode)} aria-label="Cover type" className={FIELD}>
                  <option value="cashless">Cashless</option>
                  <option value="reimbursement">Reimbursement (patient pays, claims later)</option>
                </select>
              )}
              {verdict && (
                <div className="space-y-1 text-sm">
                  <p className="flex flex-wrap items-center gap-2"><span className="text-muted-foreground">Cover</span><CoverageBadge verdict={verdict} /></p>
                  {verdict.detail && <p className="text-xs text-muted-foreground">{verdict.detail}</p>}
                  {coverBlocks && <p role="alert" className="text-xs text-destructive">A cashless admission needs cover in force. Choose Reimbursement or Self-pay, or fix the policy.</p>}
                  {coverMode === 'cashless' && verdict.severity === 'block' && emergency && <p className="text-xs text-warning">Emergency admission: proceeding, settle cover or self-pay later.</p>}
                </div>
              )}
              {policyId !== '' && (
                <select value={preauthId} onChange={(e) => setPreauthId(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Pre-authorisation" className={FIELD}>
                  <option value="">No pre-authorisation</option>
                  {preauthChoices.map((p) => (
                    <option key={p.id} value={p.id}>{[p.preauthNumber, cap(p.status.replace(/_/g, ' ')), p.approvedPaise !== null ? `${money(p.approvedPaise)} approved` : null].filter(Boolean).join(' · ')}</option>
                  ))}
                </select>
              )}
            </fieldset>

            <fieldset className={SECTION}>
              <legend className={LEGEND}>Deposit</legend>
              <label htmlFor={label('deposit')} className="block text-sm">Deposit required (₹)</label>
              <input id={label('deposit')} value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" className={FIELD} />
              {depositPaise === null && <p className="text-xs text-warning">Enter an amount in rupees, for example 5000.</p>}
              <p className="text-xs text-muted-foreground">Collected at the Cash Desk after admission.</p>
            </fieldset>

            {openOpdAsk && (
              <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" role="alert">
                <p className="font-medium text-foreground">
                  {ctx.openOpdEncounter
                    ? `This patient has an open OPD visit (token ${ctx.openOpdEncounter.opdToken ?? 'not issued'} with ${withDoctor(ctx.openOpdEncounter.providerName)})`
                    : 'This patient has an open OPD visit today'}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={() => submit('complete')} disabled={submitting}>Complete it and admit</Button>
                  <Button type="button" variant="outline" onClick={() => submit('keep')} disabled={submitting}>Keep it open and admit</Button>
                </div>
              </div>
            )}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {ctx && ctx.activeAdmissionId === null && <Button onClick={() => submit()} disabled={!valid || submitting}>Admit</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
