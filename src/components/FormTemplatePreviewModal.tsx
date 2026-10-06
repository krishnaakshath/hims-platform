'use client'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { IntakeQuestionField, type IntakeQuestion } from '@/components/IntakeQuestionField'

// Read-only preview. This creates NO formSubmissions row and issues NO token --
// it only renders the template's questions through the same field renderer the
// intake portal uses. Do not "improve" this into a real send.
export function FormTemplatePreviewModal({ name, questions, onClose }: {
  name: string
  questions: IntakeQuestion[]
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Preview: {name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {questions.length === 0 && <p className="text-sm text-muted-foreground">This form has no questions yet.</p>}
          {questions.map((q) => (
            <IntakeQuestionField key={q.id} question={q} value={undefined} onChange={() => {}} disabled />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
