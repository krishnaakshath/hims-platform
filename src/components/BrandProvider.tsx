'use client'
import { createContext, useContext } from 'react'
import { DEFAULT_BRAND_NAME, type PublicBrand } from '@/lib/brand'

// Client components cannot read server-only `BRAND_*` env vars (only
// `NEXT_PUBLIC_*` is inlined into the browser bundle). The root layout -- a
// server component -- reads the validated brand and passes its public subset
// down through this context, so client components (nav, login forms) render
// the same brand the server does and hydration never mismatches.
const BrandContext = createContext<PublicBrand>({ name: DEFAULT_BRAND_NAME, logoUrl: null })

export function BrandProvider({ brand, children }: { brand: PublicBrand; children: React.ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>
}

export function useBrand(): PublicBrand {
  return useContext(BrandContext)
}
