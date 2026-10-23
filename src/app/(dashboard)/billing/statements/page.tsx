import { redirect } from 'next/navigation'

// Foundations T11: retired. A patient's account (the ledger of invoices, receipts and refunds) is
// on the Cash Desk; this route stays so old links land there. A server redirect before any query.
export default async function PatientStatementsPage(): Promise<never> {
  redirect('/cash-desk')
}
