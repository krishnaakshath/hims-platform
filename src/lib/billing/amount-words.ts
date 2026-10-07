// Pure: an amount in paise in Indian-system words for invoices and receipts
// ("Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six and Seventy-Eight Paise Only").
const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function belowHundred(n: number): string {
  if (n < 20) return ONES[n]
  const t = TENS[Math.floor(n / 10)]
  return n % 10 === 0 ? t : `${t}-${ONES[n % 10]}`
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100)
  const rest = n % 100
  const parts: string[] = []
  if (h > 0) parts.push(`${ONES[h]} Hundred`)
  if (rest > 0) parts.push(belowHundred(rest))
  return parts.join(' ')
}

/** Whole number in the Indian system (thousand, lakh, crore). */
function integerWords(n: number): string {
  if (n === 0) return 'Zero'
  const parts: string[] = []
  const crore = Math.floor(n / 10_000_000)
  const lakh = Math.floor((n % 10_000_000) / 100_000)
  const thousand = Math.floor((n % 100_000) / 1000)
  const rest = n % 1000
  if (crore > 0) parts.push(`${integerWords(crore)} Crore`)
  if (lakh > 0) parts.push(`${belowHundred(lakh)} Lakh`)
  if (thousand > 0) parts.push(`${belowHundred(thousand)} Thousand`)
  if (rest > 0) parts.push(belowThousand(rest))
  return parts.join(' ')
}

export function rupeesInWords(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) throw new RangeError('Amount must be a non-negative whole number of paise')
  const rupees = Math.floor(paise / 100)
  const p = paise % 100
  return `Rupees ${integerWords(rupees)}${p > 0 ? ` and ${belowHundred(p)} Paise` : ''} Only`
}
