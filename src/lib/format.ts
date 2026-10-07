// The one money-display path. The hospital has a single currency (INR); every
// amount column -- the SP2+ *Paise columns and the legacy billing tables'
// *Cents columns alike -- holds integer minor units, i.e. paise, and is shown
// through formatPaise (₹, en-IN grouping, deterministic on server and client).
export { CURRENCY, formatPaise, formatRupeesWhole, parseRupeesToPaise } from '@/lib/money'
