'use client'
import { sendJson } from '@/lib/client-fetch'
import { formatIstTime } from '@/lib/india-time'
import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowUp, ArrowDown, Trash2, Plus, ShieldAlert } from 'lucide-react'
import { SendFormModal } from '@/components/SendFormModal'
import { FormTemplatePreviewModal } from '@/components/FormTemplatePreviewModal'
import { TemplateConsentsPanel } from '@/components/TemplateConsentsPanel'
import type { AttachedConsentRow } from '@/lib/queries/form-template-consents'
import { triggerAnswers, type FormLang, type FormQuestion, type QuestionType } from '@/lib/forms/question-model'
import { QuestionConditionEditor, conditionTriggers, questionNumbers } from '@/components/forms/QuestionConditionEditor'
import { TranslationsPanel, TRANSLATED_LANGS } from '@/components/forms/TranslationsPanel'

type Question = FormQuestion

const TYPE_LABELS: Record<QuestionType, string> = {
  text: 'Text',
  textarea: 'Long text',
  date: 'Date',
  select: 'Select',
  checkbox: 'Checkbox',
  number: 'Number',
  phone: 'Phone',
  file: 'File upload',
  signature: 'Signature',
  section: 'Section heading',
}

const TYPE_HINTS: Partial<Record<QuestionType, string>> = {
  phone: 'Indian mobile number; saved as +91…',
  file: 'The patient uploads a photo or PDF.',
  signature: 'The patient signs by typing their full name.',
}

// Fallbacks for the fields the template routes require, used only when the
// first edit on /forms/new creates the template before they are filled in.
const NEW_FORM_DEFAULTS = { name: 'Untitled Form', category: 'Uncategorized', diagnosisTag: 'General' }

// On /forms/new the template is created once the editing pauses for this long,
// so typing a title sends one POST rather than one per keystroke.
const CREATE_DELAY_MS = 500

/**
 * A visibleIf survives only while its trigger is still an EARLIER select or
 * checkbox question (moving, removing or retyping a question can break that).
 */
function pruneConditions(qs: Question[]): Question[] {
  return qs.map((q, i) => {
    if (!q.visibleIf) return q
    if (conditionTriggers(qs, i).some((t) => t.id === q.visibleIf!.questionId)) return q
    return { ...q, visibleIf: null }
  })
}

/**
 * Why the cleaned questions cannot be saved as they stand: a "Show only if"
 * that names an answer its trigger no longer offers (the dependant could never
 * be shown). The template routes refuse the same thing; this says it plainly.
 */
function staleConditionError(qs: Question[]): string | null {
  const numbers = questionNumbers(qs)
  const name = (q: Question) => (q.type === 'section' ? `Section "${q.label}"` : `Q${numbers.get(q.id)}`)
  for (const q of qs) {
    if (!q.visibleIf) continue
    const trigger = qs.find((t) => t.id === q.visibleIf!.questionId)
    const answers = trigger ? triggerAnswers(trigger) : null
    if (trigger && answers && !answers.includes(q.visibleIf.equals)) {
      return `${name(q)} is shown only for an answer ${name(trigger)} no longer has. Choose an answer for its "Show only if" or remove the condition.`
    }
  }
  return null
}

/** Translated options kept one for one with the English options after an index-wise edit. */
function remapI18nOptions(q: Question, remap: (arr: string[]) => string[]): Question['i18n'] {
  if (!q.i18n) return q.i18n
  const out: NonNullable<Question['i18n']> = {}
  for (const { lang } of TRANSLATED_LANGS) {
    const t = q.i18n[lang]
    if (!t) continue
    out[lang] = t.options ? { ...t, options: remap(t.options) } : t
  }
  return out
}

/**
 * The questions as the routes want them: blank select options dropped (with
 * their scores and translations), translations trimmed to what was typed and
 * sized one for one with the English options, conditions still valid.
 */
function cleanQuestions(qs: Question[]): Question[] {
  return pruneConditions(qs.map((q) => {
    let next = q
    if (q.type === 'select') {
      const options = q.options ?? []
      const keep = options.map((o, i) => (o.trim() ? i : -1)).filter((i) => i !== -1)
      const pick = <T,>(arr: T[]) => keep.map((i) => arr[i])
      next = {
        ...q,
        options: keep.map((i) => options[i].trim()),
        optionScores: q.optionScores ? pick(q.optionScores) : q.optionScores,
        i18n: remapI18nOptions(q, (arr) => keep.map((i) => arr[i] ?? '')),
      }
    }
    if (next.i18n) {
      const english = next.options ?? []
      const i18n: NonNullable<Question['i18n']> = {}
      for (const { lang } of TRANSLATED_LANGS) {
        const t = next.i18n[lang]
        if (!t) continue
        const entry: { label?: string; options?: string[] } = {}
        if (t.label && t.label.trim()) entry.label = t.label.trim()
        if (next.type === 'select' && t.options && english.length > 0) {
          const options = english.map((_, i) => (t.options![i] ?? '').trim())
          if (options.some(Boolean)) entry.options = options
        }
        if (entry.label !== undefined || entry.options !== undefined) i18n[lang] = entry
      }
      next = { ...next }
      if (Object.keys(i18n).length > 0) next.i18n = i18n
      else delete next.i18n
    }
    return next
  }))
}

const COMMON_ACTIONS = [
  'Add a question',
  'Mark a question as containing PHI',
  'Attach a consent document',
  'Send the form to a client',
  'Archive the template',
]

export function FormBuilderEditor({
  templateId, initial, initialIsActive, folders, attachedConsents, allConsentDocuments, patients,
}: {
  // null on /forms/new: nothing exists until the first edit creates it (spec D11).
  templateId: number | null
  initial: {
    name: string
    category: string
    diagnosisTag: string
    questions: Question[]
    languages: FormLang[]
    folderId: number | null
  }
  initialIsActive: boolean
  folders: { id: number; name: string }[]
  attachedConsents: AttachedConsentRow[]
  allConsentDocuments: { id: number; name: string }[]
  // Forwarded untouched to SendFormModal; its element shape is that component's.
  patients: ComponentProps<typeof SendFormModal>['patients']
}) {
  const router = useRouter()
  const [name, setName] = useState(initial.name)
  const [category, setCategory] = useState(initial.category)
  const [diagnosisTag, setDiagnosisTag] = useState(initial.diagnosisTag)
  const [questions, setQuestions] = useState<Question[]>(initial.questions)
  const [languages, setLanguages] = useState<FormLang[]>(initial.languages)
  const [folderId, setFolderId] = useState<number | null>(initial.folderId)
  const [tab, setTab] = useState<'questions' | 'consents' | 'translations'>('questions')
  const [showSend, setShowSend] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify({ name: initial.name, category: initial.category, diagnosisTag: initial.diagnosisTag, folderId: initial.folderId, languages: initial.languages, questions: initial.questions }))
  // Null until the first save in this session: the status reads plain "Saved"
  // (identical on server and client), then "Saved · <IST time>" after a save.
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // No autosave, deliberately: a half-edited question must never reach a
  // patient mid-edit. Status is derived by comparing against the last save.
  const snapshot = JSON.stringify({ name, category, diagnosisTag, folderId, languages, questions })
  const isDirty = snapshot !== savedSnapshot
  const creatingRef = useRef(false)
  const [creating, setCreating] = useState(false)

  function newId(prefix: string) {
    // Unique within the template even when two rows are added in one millisecond.
    let id = `${prefix}${Date.now()}`
    while (questions.some((q) => q.id === id)) id += 'x'
    return id
  }

  function addQuestion() {
    setTab('questions')
    setQuestions([...questions, { id: newId('q'), label: 'New question', type: 'text', hipaaSensitive: false, required: false }])
  }

  function addSection() {
    setTab('questions')
    setQuestions([...questions, { id: newId('s'), label: 'New section', type: 'section', hipaaSensitive: false, required: false }])
  }

  function removeQuestion(id: string) {
    setQuestions(pruneConditions(questions.filter((q) => q.id !== id)))
  }

  function updateQuestion(id: string, patch: Partial<Question>) {
    setQuestions(questions.map((q) => (q.id === id ? { ...q, ...patch } : q)))
  }

  function changeType(id: string, type: QuestionType) {
    setQuestions(pruneConditions(questions.map((q) => {
      if (q.id !== id) return q
      const next: Question = { ...q, type }
      // min/max belong to number questions only; a section is never required.
      if (type !== 'number') { delete next.min; delete next.max }
      if (type === 'section') next.required = false
      return next
    })))
  }

  function setBound(id: string, key: 'min' | 'max', raw: string) {
    setQuestions(questions.map((q) => {
      if (q.id !== id) return q
      const next = { ...q }
      const n = Number(raw)
      if (raw.trim() === '' || !Number.isFinite(n)) delete next[key]
      else next[key] = n
      return next
    }))
  }

  function moveQuestion(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= questions.length) return
    const next = [...questions]
    ;[next[index], next[target]] = [next[target], next[index]]
    setQuestions(pruneConditions(next))
  }

  function addOption(id: string) {
    setQuestions(questions.map((q) => (q.id === id ? {
      ...q,
      options: [...(q.options ?? []), ''],
      // A newly added option has no score yet -- push `null` (distinguishable
      // from a real 0-point option) to keep optionScores in lockstep with
      // options, only when the question actually has scores to keep in sync.
      optionScores: q.optionScores ? [...q.optionScores, null] : q.optionScores,
      i18n: remapI18nOptions(q, (arr) => [...arr, ...Array(Math.max(0, (q.options ?? []).length + 1 - arr.length)).fill('')]),
    } : q)))
  }

  function removeOption(id: string, index: number) {
    const options = questions.find((q) => q.id === id)?.options ?? []
    const removed = (options[index] ?? '').trim()
    // A "Show only if" on the removed answer could never be met any more.
    const orphaned = !options.some((o, i) => i !== index && o.trim() === removed)
    setQuestions(questions.map((q) => {
      if (q.id === id) {
        return {
          ...q,
          options: (q.options ?? []).filter((_, i) => i !== index),
          optionScores: q.optionScores ? q.optionScores.filter((_, i) => i !== index) : q.optionScores,
          i18n: remapI18nOptions(q, (arr) => arr.filter((_, i) => i !== index)),
        }
      }
      if (orphaned && q.visibleIf?.questionId === id && q.visibleIf.equals === removed) return { ...q, visibleIf: null }
      return q
    }))
  }

  function updateOption(id: string, index: number, value: string) {
    const before = (questions.find((q) => q.id === id)?.options?.[index] ?? '').trim()
    setQuestions(questions.map((q) => {
      if (q.id === id) return { ...q, options: (q.options ?? []).map((o, i) => (i === index ? value : o)) }
      // Renaming an answer carries every "Show only if" on it to the new text.
      if (q.visibleIf?.questionId === id && q.visibleIf.equals === before) return { ...q, visibleIf: { questionId: id, equals: value.trim() } }
      return q
    }))
  }

  function moveOption(id: string, index: number, direction: -1 | 1) {
    setQuestions(questions.map((q) => {
      if (q.id !== id) return q
      const opts = [...(q.options ?? [])]
      const target = index + direction
      if (target < 0 || target >= opts.length) return q
      ;[opts[index], opts[target]] = [opts[target], opts[index]]
      const scores = q.optionScores ? [...q.optionScores] : undefined
      if (scores) [scores[index], scores[target]] = [scores[target], scores[index]]
      const swap = (arr: string[]) => {
        const out = [...arr]
        ;[out[index], out[target]] = [out[target], out[index]]
        return out
      }
      return { ...q, options: opts, optionScores: scores ?? q.optionScores, i18n: remapI18nOptions(q, swap) }
    }))
  }

  // First edit on /forms/new: create the template once, then move to its own
  // URL. Until then nothing exists, so an untouched new form leaves no row.
  const create = useCallback(async () => {
    if (creatingRef.current) return
    // Blank option rows are dropped (with their scores and translations) so
    // choice questions never ship empty entries -- see cleanQuestions.
    const cleaned = cleanQuestions(questions)
    const stale = staleConditionError(cleaned)
    if (stale) { setSaveError(stale); return }
    creatingRef.current = true
    setCreating(true)
    setSaveError(null)
    const res = await sendJson<{ id: number }>('/api/form-templates', 'POST', {
      name: name.trim() || NEW_FORM_DEFAULTS.name,
      category: category.trim() || NEW_FORM_DEFAULTS.category,
      diagnosisTag: diagnosisTag.trim() || NEW_FORM_DEFAULTS.diagnosisTag,
      folderId,
      languages,
      questions: cleaned,
    })
    if (res.ok) {
      // The editor stays read-only ("Saving…") until /forms/<id> replaces it:
      // that page loads from the database, so an edit typed now would be lost.
      setSavedSnapshot(snapshot)
      router.replace(`/forms/${res.data.id}`)
    } else {
      // Allow a retry: the next edit, or Save Form, tries again.
      creatingRef.current = false
      setCreating(false)
      setSaveError(res.error)
    }
  }, [name, category, diagnosisTag, folderId, languages, questions, snapshot, router])

  useEffect(() => {
    if (templateId !== null || !isDirty || creatingRef.current) return
    const timer = setTimeout(() => { void create() }, CREATE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [templateId, isDirty, create])

  async function save() {
    if (templateId === null) { await create(); return }
    const cleaned = cleanQuestions(questions)
    const stale = staleConditionError(cleaned)
    if (stale) { setSaveError(stale); return }
    setSaving(true)
    setSaveError(null)
    const res = await sendJson(`/api/form-templates/${templateId}`, 'PUT', { name, category, diagnosisTag, folderId, languages, questions: cleaned })
    setSaving(false)
    if (res.ok) {
      setQuestions(cleaned)
      setSavedSnapshot(JSON.stringify({ name, category, diagnosisTag, folderId, languages, questions: cleaned }))
      setLastSavedAt(new Date())
      router.refresh()
    } else {
      setSaveError(res.error)
    }
  }

  async function archive() {
    if (templateId === null) return
    setSaveError(null)
    const res = await sendJson(`/api/form-templates/${templateId}`, 'PUT', { isActive: false })
    if (res.ok) {
      router.push('/forms')
    } else {
      setSaveError(res.error)
    }
  }

  const btn = 'inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50'
  const isNew = templateId === null
  const numbers = questionNumbers(questions)
  const questionCount = numbers.size
  const statusText = creating || saving ? 'Saving…'
    : isDirty ? 'Unsaved changes'
    : isNew ? 'Not saved yet'
    : lastSavedAt ? `Saved · ${formatIstTime(lastSavedAt)}` : 'Saved'
  const toggleTab = (t: 'consents' | 'translations') => setTab(tab === t ? 'questions' : t)

  return (
    <div className="flex items-start gap-6">
    <div className="min-w-0 max-w-2xl flex-1">
      <Link href="/forms" className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-primary">← Form Templates</Link>
      {/* Read-only while the first create is in flight (see create). */}
      <fieldset disabled={creating} className="m-0 min-w-0 border-0 p-0">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {/* Sending and attaching consents need a saved template. */}
        <button onClick={() => setShowSend(true)} disabled={isNew} className={btn}>Send to Client</button>
        <button onClick={() => setShowPreview(true)} className={btn}>Preview</button>
        <button onClick={() => toggleTab('consents')} disabled={isNew} aria-pressed={tab === 'consents'} className={`${btn} ${tab === 'consents' ? 'bg-secondary' : ''}`}>Consent Forms</button>
        <button onClick={() => toggleTab('translations')} aria-pressed={tab === 'translations'} className={`${btn} ${tab === 'translations' ? 'bg-secondary' : ''}`}>Translations</button>
        <span className="ml-auto text-xs text-muted-foreground" role="status">{statusText}</span>
        <button onClick={save} disabled={saving || creating} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
          {saving || creating ? 'Saving…' : 'Save Form'}
        </button>
        <button onClick={addQuestion} className={btn}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add New Question
        </button>
        <button onClick={addSection} className={btn}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add Section
        </button>
      </div>
      {isNew && <p className="mb-4 text-xs text-muted-foreground">This form is created as soon as you start editing it.</p>}
      <div className="mb-6 rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm">
        <div className="space-y-3">
          <div>
            <label htmlFor="template-name" className="mb-1 block text-xs font-medium text-muted-foreground">Form name</label>
            <input id="template-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={NEW_FORM_DEFAULTS.name} className="w-full rounded-md border border-border px-3 py-2 text-lg font-semibold text-foreground" />
          </div>
          <div className="flex gap-3">
            <div className="w-1/3">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Category</label>
              <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            </div>
            <div className="w-1/3">
              <label htmlFor="template-folder" className="mb-1 block text-xs font-medium text-muted-foreground">Folder</label>
              <select id="template-folder" value={folderId ?? ''} onChange={(e) => setFolderId(e.target.value === '' ? null : Number(e.target.value))} className="w-full rounded-md border border-border px-3 py-2 text-sm">
                <option value="">— No folder —</option>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
            <div className="w-1/3">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Diagnosis tag</label>
              <input value={diagnosisTag} onChange={(e) => setDiagnosisTag(e.target.value)} placeholder="Diagnosis tag" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            </div>
          </div>
        </div>
      </div>

      {tab === 'consents' && templateId !== null ? (
        <TemplateConsentsPanel templateId={templateId} attached={attachedConsents} allDocuments={allConsentDocuments} />
      ) : tab === 'translations' ? (
        <TranslationsPanel
          questions={questions}
          languages={languages}
          onLanguagesChange={setLanguages}
          onI18nChange={(id, i18n) => updateQuestion(id, { i18n })}
        />
      ) : (
      <div className="space-y-3">
        {questions.length === 0 && <p className="text-sm text-muted-foreground">No questions yet. Use Add New Question or Add Section to start.</p>}
        {questions.map((q, i) => {
          const isSection = q.type === 'section'
          const typeSelect = (
            <select aria-label="Question type" value={q.type} onChange={(e) => changeType(q.id, e.target.value as QuestionType)} className="rounded-md border border-border px-2 py-1.5 text-xs text-foreground focus:border-primary/40 focus:outline-none">
              {(Object.keys(TYPE_LABELS) as QuestionType[]).map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select>
          )
          const rowActions = (
            <div className="flex shrink-0 items-center gap-0.5">
              <button onClick={() => moveQuestion(i, -1)} disabled={i === 0} aria-label="Move up" className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" aria-hidden="true" /></button>
              <button onClick={() => moveQuestion(i, 1)} disabled={i === questions.length - 1} aria-label="Move down" className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" aria-hidden="true" /></button>
              <button onClick={() => removeQuestion(q.id)} aria-label={isSection ? 'Remove section' : 'Remove question'} className="rounded-md p-1.5 text-destructive hover:bg-destructive/10"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>
            </div>
          )
          const condition = (
            <QuestionConditionEditor questions={questions} index={i} value={q.visibleIf} onChange={(visibleIf) => updateQuestion(q.id, { visibleIf })} />
          )

          if (isSection) {
            return (
              <div key={q.id} data-testid="builder-row" data-kind="section" className="border-b-2 border-primary/20 px-1 pb-2 pt-4">
                <div className="flex items-center gap-2.5">
                  <input aria-label="Section heading" value={q.label} onChange={(e) => updateQuestion(q.id, { label: e.target.value })} className="flex-1 rounded-md border border-transparent bg-transparent px-1 py-1 text-lg font-semibold text-foreground hover:border-border focus:border-primary/40 focus:outline-none" />
                  {typeSelect}
                  {rowActions}
                </div>
                <div className="mt-1 px-1 empty:hidden">{condition}</div>
              </div>
            )
          }

          return (
          <div key={q.id} data-testid="builder-row" data-kind="question" className="rounded-xl border border-primary/10 bg-card/80 p-4 shadow-sm backdrop-blur-sm transition-all duration-200 hover:border-primary/25 hover:shadow-md">
            <div className="mb-3 flex items-center gap-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{numbers.get(q.id)}</span>
              <input value={q.label} onChange={(e) => updateQuestion(q.id, { label: e.target.value })} aria-label={`Question ${numbers.get(q.id)} text`} className="flex-1 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium text-foreground focus:border-primary/40 focus:outline-none" />
              {typeSelect}
              {rowActions}
            </div>
            <div className="flex flex-wrap gap-3 pl-8 text-xs text-muted-foreground">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={q.required} onChange={(e) => updateQuestion(q.id, { required: e.target.checked })} /> Required</label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={q.hipaaSensitive} onChange={(e) => updateQuestion(q.id, { hipaaSensitive: e.target.checked })} />
                <span className="inline-flex items-center gap-1">
                  <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                  Contains PHI
                </span>
              </label>
              {TYPE_HINTS[q.type] && <span>{TYPE_HINTS[q.type]}</span>}
            </div>

            {q.type === 'number' && (
              <div className="mt-3 flex gap-3 border-t border-border pl-8 pt-3 text-xs text-muted-foreground">
                <label className="flex items-center gap-1.5">
                  Minimum
                  <input type="number" value={q.min ?? ''} onChange={(e) => setBound(q.id, 'min', e.target.value)} className="w-24 rounded-md border border-border px-2 py-1 text-xs text-foreground" />
                </label>
                <label className="flex items-center gap-1.5">
                  Maximum
                  <input type="number" value={q.max ?? ''} onChange={(e) => setBound(q.id, 'max', e.target.value)} className="w-24 rounded-md border border-border px-2 py-1 text-xs text-foreground" />
                </label>
              </div>
            )}
            {q.type === 'select' && (
              <div className="mt-3 space-y-1.5 border-t border-border pl-8 pt-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Options</p>
                {(q.options ?? []).length === 0 && (
                  <p className="text-xs text-muted-foreground">No options yet — add at least one so patients have something to choose.</p>
                )}
                {(q.options ?? []).map((option, oi) => (
                  <div key={oi} className="flex items-center gap-1.5">
                    <input
                      value={option}
                      onChange={(e) => updateOption(q.id, oi, e.target.value)}
                      placeholder={`Option ${oi + 1}`}
                      aria-label={`Option ${oi + 1} for ${q.label}`}
                      className="flex-1 rounded-md border border-border px-2 py-1 text-xs text-foreground focus:border-primary/40 focus:outline-none"
                    />
                    <button onClick={() => moveOption(q.id, oi, -1)} disabled={oi === 0} aria-label="Move option up" className="rounded-md p-1 text-muted-foreground hover:bg-secondary disabled:opacity-30"><ArrowUp className="h-3 w-3" aria-hidden="true" /></button>
                    <button onClick={() => moveOption(q.id, oi, 1)} disabled={oi === (q.options?.length ?? 0) - 1} aria-label="Move option down" className="rounded-md p-1 text-muted-foreground hover:bg-secondary disabled:opacity-30"><ArrowDown className="h-3 w-3" aria-hidden="true" /></button>
                    <button onClick={() => removeOption(q.id, oi)} aria-label="Remove option" className="rounded-md p-1 text-destructive hover:bg-destructive/10"><Trash2 className="h-3 w-3" aria-hidden="true" /></button>
                  </div>
                ))}
                <button onClick={() => addOption(q.id)} className="text-xs font-medium text-primary hover:underline">+ Add option</button>
              </div>
            )}
            <div className="mt-3 pl-8 empty:hidden">{condition}</div>
          </div>
          )
        })}
      </div>
      )}

      </fieldset>
      {saveError && <p role="alert" className="mt-3 text-sm text-destructive">{saveError}</p>}
    </div>

    <aside className="w-64 shrink-0 space-y-3 rounded-xl border border-primary/10 bg-card/80 p-4 text-sm shadow-sm">
      <p className="text-base font-semibold text-foreground">{name || NEW_FORM_DEFAULTS.name}</p>
      <p className="text-xs text-muted-foreground">{questionCount} question{questionCount === 1 ? '' : 's'}</p>
      <p className="text-xs text-muted-foreground">{attachedConsents.length} attached consent{attachedConsents.length === 1 ? '' : 's'}</p>
      <div className="border-t border-border pt-3">
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Common things you can do here</p>
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
          {COMMON_ACTIONS.map((a) => <li key={a}>{a}</li>)}
        </ul>
      </div>
      {initialIsActive && !isNew && (
        <>
          <button onClick={archive} disabled={isDirty} className="w-full rounded-md border border-border px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50">Archive</button>
          {isDirty && <p className="text-xs text-muted-foreground">Save your changes before archiving.</p>}
        </>
      )}
    </aside>

    {showSend && templateId !== null && <SendFormModal templates={[{ id: templateId, name }]} patients={patients} onClose={() => setShowSend(false)} />}
    {showPreview && <FormTemplatePreviewModal name={name} questions={questions} onClose={() => setShowPreview(false)} />}
    </div>
  )
}
