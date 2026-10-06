import { describe, it, expect } from 'vitest'
import { checkFormChartDiscrepancies, type FormQuestion } from '@/lib/form-chart-discrepancy'

const SELECT_QUESTION: FormQuestion = {
  id: 'q4',
  label: 'Currently taking antidepressants?',
  type: 'select',
  compareToChart: { type: 'medication_active', medicationClass: 'SSRI/SNRI antidepressant' },
}

const TEXT_QUESTION: FormQuestion = {
  id: 'q3',
  label: 'Current stimulant medication (if any)',
  type: 'text',
  compareToChart: { type: 'medication_active', medicationClass: 'Stimulant' },
}

const UNRELATED_QUESTION: FormQuestion = { id: 'q1', label: 'Full legal name', type: 'text' }

describe('checkFormChartDiscrepancies', () => {
  it('finds no discrepancy when the patient says Yes and the chart agrees', () => {
    const results = checkFormChartDiscrepancies([SELECT_QUESTION], { q4: 'Yes' }, new Set(['SSRI/SNRI antidepressant']))
    expect(results).toHaveLength(0)
  })

  it('finds no discrepancy when the patient says No and the chart agrees', () => {
    const results = checkFormChartDiscrepancies([SELECT_QUESTION], { q4: 'No' }, new Set())
    expect(results).toHaveLength(0)
  })

  it('flags a discrepancy when the patient says No but the chart shows an active medication', () => {
    const results = checkFormChartDiscrepancies([SELECT_QUESTION], { q4: 'No' }, new Set(['SSRI/SNRI antidepressant']))
    expect(results).toHaveLength(1)
    expect(results[0].questionLabel).toBe('Currently taking antidepressants?')
    expect(results[0].chartFinding).toContain('active SSRI/SNRI antidepressant')
  })

  it('flags a discrepancy when the patient says Yes but the chart shows nothing active', () => {
    const results = checkFormChartDiscrepancies([SELECT_QUESTION], { q4: 'Yes' }, new Set())
    expect(results).toHaveLength(1)
    expect(results[0].chartFinding).toContain('No active')
  })

  it('treats a free-text answer as a claim of "yes" when non-empty', () => {
    const noDiscrepancy = checkFormChartDiscrepancies([TEXT_QUESTION], { q3: 'Adderall 20mg' }, new Set(['Stimulant']))
    expect(noDiscrepancy).toHaveLength(0)

    const discrepancy = checkFormChartDiscrepancies([TEXT_QUESTION], { q3: 'Adderall 20mg' }, new Set())
    expect(discrepancy).toHaveLength(1)
  })

  it('treats a blank free-text answer as a claim of "no"', () => {
    const noDiscrepancy = checkFormChartDiscrepancies([TEXT_QUESTION], { q3: '' }, new Set())
    expect(noDiscrepancy).toHaveLength(0)

    const discrepancy = checkFormChartDiscrepancies([TEXT_QUESTION], { q3: '' }, new Set(['Stimulant']))
    expect(discrepancy).toHaveLength(1)
  })

  it('ignores questions with no compareToChart tag', () => {
    const results = checkFormChartDiscrepancies([UNRELATED_QUESTION], { q1: 'Maria Alvarez' }, new Set())
    expect(results).toHaveLength(0)
  })

  it('treats a missing answer the same as an empty one', () => {
    const results = checkFormChartDiscrepancies([SELECT_QUESTION], {}, new Set(['SSRI/SNRI antidepressant']))
    expect(results).toHaveLength(1)
  })
})
