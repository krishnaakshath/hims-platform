'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { CarePlanWithGoals, CarePlanGoal } from '@/lib/queries/care-plans'

// Matches medical-record/page.tsx's own (page-local, unexported) SECTION_HEADING
// convention -- duplicated here rather than imported since CarePlanSection is
// this section's sole child in the page (see page.tsx's Care Plan section),
// so it owns rendering its own title, unlike Notes' split between the page's
// <h2> and NoteForm's button-only role.
const SECTION_HEADING = 'border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

function formatDate(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Same dot + plain-text-label convention as NoteStatusPill (never color
// alone) -- kept local rather than shared since it's keyed off a status
// union (care plan goal status) that doesn't belong to NoteForm's file.
const GOAL_STATUS_CONFIG: Record<CarePlanGoal['status'], { label: string; dotClassName: string; textClassName: string }> = {
  active: { label: 'Active', dotClassName: 'bg-primary', textClassName: 'text-primary' },
  met: { label: 'Met', dotClassName: 'bg-success', textClassName: 'text-success' },
  not_met: { label: 'Not Met', dotClassName: 'bg-destructive', textClassName: 'text-destructive' },
  discontinued: { label: 'Discontinued', dotClassName: 'bg-muted-foreground', textClassName: 'text-muted-foreground' },
}

function GoalStatusPill({ status }: { status: CarePlanGoal['status'] }) {
  const config = GOAL_STATUS_CONFIG[status]
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${config.textClassName}`}>
      <span className={`h-2 w-2 rounded-full ${config.dotClassName}`} aria-hidden="true" />
      {config.label}
    </span>
  )
}

function GoalRow({ goal, canWrite }: { goal: CarePlanGoal; canWrite: boolean }) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function setStatus(status: 'met' | 'not_met' | 'discontinued') {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/care-plan-goals/${goal.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not update this goal.')
  }

  return (
    <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-foreground">{goal.description}</p>
        <GoalStatusPill status={goal.status} />
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">Target date: {formatDate(goal.targetDate)}</p>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      {canWrite && goal.status === 'active' && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="xs" variant="outline" onClick={() => setStatus('met')} disabled={submitting}>Mark met</Button>
          <Button size="xs" variant="outline" onClick={() => setStatus('not_met')} disabled={submitting}>Mark not met</Button>
          <Button size="xs" variant="destructive" onClick={() => setStatus('discontinued')} disabled={submitting}>Discontinue</Button>
        </div>
      )}
    </div>
  )
}

interface GoalDraft { description: string; targetDate: string }

function NewCarePlanForm({ patientId, hasCurrentPlan }: { patientId: string; hasCurrentPlan: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [nextReviewDate, setNextReviewDate] = useState('')
  const [goals, setGoals] = useState<GoalDraft[]>([{ description: '', targetDate: '' }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setTitle('')
    setNextReviewDate('')
    setGoals([{ description: '', targetDate: '' }])
    setError(null)
  }

  function updateGoal(index: number, patch: Partial<GoalDraft>) {
    setGoals((prev) => prev.map((g, i) => (i === index ? { ...g, ...patch } : g)))
  }

  function addGoalRow() {
    setGoals((prev) => [...prev, { description: '', targetDate: '' }])
  }

  function removeGoalRow(index: number) {
    setGoals((prev) => prev.filter((_, i) => i !== index))
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await fetch(`/api/patients/${patientId}/care-plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        ...(nextReviewDate ? { nextReviewDate } : {}),
        goals: goals
          .filter((g) => g.description.trim().length > 0)
          .map((g) => ({ description: g.description, ...(g.targetDate ? { targetDate: g.targetDate } : {}) })),
      }),
    })
    setSubmitting(false)
    if (res.ok) { router.refresh(); setOpen(false); reset(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not create this care plan.')
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>New Care Plan</Button>
      {open && (
        <Dialog open onOpenChange={(o) => { if (!o) { setOpen(false); reset() } }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>New Care Plan</DialogTitle>
              {hasCurrentPlan && (
                <DialogDescription>
                  Starting a new plan supersedes the current one — it stays visible in history below.
                </DialogDescription>
              )}
            </DialogHeader>
            <div className="max-h-[60vh] space-y-3 overflow-y-auto">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Plan title"
                aria-label="Plan title"
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
              />
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="care-plan-next-review">Next review date (optional)</label>
                <input
                  id="care-plan-next-review"
                  type="date"
                  value={nextReviewDate}
                  onChange={(e) => setNextReviewDate(e.target.value)}
                  className="w-full rounded-md border border-border px-3 py-2 text-sm"
                />
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Goals</p>
                {goals.map((goal, index) => (
                  <div key={index} className="flex items-start gap-2">
                    <input
                      value={goal.description}
                      onChange={(e) => updateGoal(index, { description: e.target.value })}
                      placeholder="Goal description"
                      aria-label={`Goal ${index + 1} description`}
                      className="flex-1 rounded-md border border-border px-3 py-2 text-sm"
                    />
                    <input
                      type="date"
                      value={goal.targetDate}
                      onChange={(e) => updateGoal(index, { targetDate: e.target.value })}
                      aria-label={`Goal ${index + 1} target date`}
                      className="w-36 rounded-md border border-border px-3 py-2 text-sm"
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => removeGoalRow(index)}
                      disabled={goals.length === 1}
                      aria-label={`Remove goal ${index + 1}`}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
                <Button size="xs" variant="outline" onClick={addGoalRow}>
                  <Plus /> Add goal
                </Button>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setOpen(false); reset() }}>Cancel</Button>
              <Button onClick={submit} disabled={submitting || title.trim().length === 0}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

function CarePlanCard({ plan, canWrite }: { plan: CarePlanWithGoals; canWrite: boolean }) {
  return (
    <div className="space-y-2.5">
      <div>
        <p className="font-medium text-foreground">{plan.title}</p>
        <p className="text-xs text-muted-foreground">
          Started {formatDate(plan.startedAt)} by {plan.authorName} · Next review: {formatDate(plan.nextReviewDate)}
        </p>
      </div>
      {plan.goals.length === 0 ? (
        <p className="text-sm text-muted-foreground">No goals recorded for this plan.</p>
      ) : (
        <div className="space-y-2">
          {plan.goals.map((goal) => <GoalRow key={goal.id} goal={goal} canWrite={canWrite} />)}
        </div>
      )}
    </div>
  )
}

function HistoryPlan({ plan }: { plan: CarePlanWithGoals }) {
  return (
    <div className="rounded-lg border border-border p-3 text-xs">
      <p className="font-medium text-foreground">{plan.title}</p>
      <p className="text-muted-foreground">
        Started {formatDate(plan.startedAt)} by {plan.authorName} · Superseded {formatDate(plan.supersededAt)}
      </p>
      {plan.goals.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {plan.goals.map((goal) => (
            <li key={goal.id} className="flex items-center justify-between gap-2">
              <span className="text-foreground">{goal.description}</span>
              <GoalStatusPill status={goal.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function CarePlanSection({ patientId, plans, canWrite }: { patientId: string; plans: CarePlanWithGoals[]; canWrite: boolean }) {
  const currentPlan = plans.find((p) => p.status === 'active')
  const historyPlans = plans.filter((p) => p.id !== currentPlan?.id)

  return (
    <div className="space-y-3">
      <div className="mb-3 flex items-center justify-between">
        <h2 className={SECTION_HEADING}>Care Plan</h2>
        {canWrite && <NewCarePlanForm patientId={patientId} hasCurrentPlan={!!currentPlan} />}
      </div>
      {currentPlan ? (
        <CarePlanCard plan={currentPlan} canWrite={canWrite} />
      ) : (
        <p className="text-sm text-muted-foreground">No care plan on file.</p>
      )}
      {historyPlans.length > 0 && (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer font-medium">{historyPlans.length} prior plan(s)</summary>
          <div className="mt-2 space-y-2">
            {historyPlans.map((plan) => <HistoryPlan key={plan.id} plan={plan} />)}
          </div>
        </details>
      )}
    </div>
  )
}
