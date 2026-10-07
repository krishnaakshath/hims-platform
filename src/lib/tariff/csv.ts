// Minimal RFC 4180 CSV parser (character-level state machine, no dependency).
export class CsvSyntaxError extends Error {
  line: number
  constructor(message: string, line: number) {
    super(message)
    this.name = 'CsvSyntaxError'
    this.line = line
  }
}

export interface CsvRecord { line: number; cells: string[] }

/**
 * Handles quoted fields, "" escapes, embedded commas/newlines in quotes, CRLF/LF, a leading BOM,
 * and skips blank lines, including rows of only commas/whitespace. `line` is the 1-based physical line on which a record starts.
 * Error messages never include the input text.
 */
export function parseCsv(input: string): { header: string[]; rows: CsvRecord[] } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const records: CsvRecord[] = []
  let cells: string[] = []
  let cell = ''
  let inQuotes = false
  let afterQuote = false      // just closed a quoted field; only , or EOL may follow
  let wasQuoted = false       // current record contains a quoted field (so not "blank")
  let line = 1
  let recordLine = 1
  let quoteLine = 1

  const endCell = () => { cells.push(cell); cell = ''; afterQuote = false }
  const endRecord = () => {
    endCell()
    // Excel writes blank rows as ',,,' (sometimes with stray spaces): only-separator rows are blank too.
    const blank = !wasQuoted && cells.every((c) => c.trim() === '')
    if (!blank) records.push({ line: recordLine, cells })
    cells = []; wasQuoted = false
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else { inQuotes = false; afterQuote = true }
      } else {
        if (ch === '\n') line++
        cell += ch
      }
      continue
    }
    if (ch === '"') {
      if (cell !== '' || afterQuote) throw new CsvSyntaxError('Unexpected quote character', line)
      inQuotes = true; wasQuoted = true; quoteLine = line
    } else if (ch === ',') {
      endCell()
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRecord()
      line++
      recordLine = line
    } else {
      if (afterQuote) throw new CsvSyntaxError('Unexpected text after a closing quote', line)
      cell += ch
    }
  }
  if (inQuotes) throw new CsvSyntaxError('Unterminated quoted field', quoteLine)
  if (cell !== '' || cells.length > 0 || wasQuoted) endRecord()

  const [first, ...rows] = records
  return { header: first ? first.cells : [], rows }
}
