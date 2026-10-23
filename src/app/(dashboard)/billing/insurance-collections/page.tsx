import { redirect } from 'next/navigation'

// Foundations T11: retired. Insurance claims are worked under RCM; this route stays so old links
// and bookmarks land there. A server redirect before any session read or query (the RCM page gates).
export default async function InsuranceCollectionsPage(): Promise<never> {
  redirect('/rcm/claims')
}
