'use client'
import { createContext, useContext, useMemo } from 'react'
import { loadBrand, type PublicBrand } from '@/lib/brand'
import { toPublicBrand } from '@/lib/brand-resolve'

// Client components cannot read server-only `BRAND_*` env vars (only
// `NEXT_PUBLIC_*` is inlined into the browser bundle) or the database. The
// root layout -- a server component -- resolves the brand per request
// (getBrand: stored Settings > Branding over env) and passes its public subset
// down through this context, so client components (nav, login forms) render
// the same brand the server does and hydration never mismatches.
const DEFAULT_PUBLIC_BRAND: PublicBrand = toPublicBrand(loadBrand({}))

const BrandContext = createContext<PublicBrand>(DEFAULT_PUBLIC_BRAND)

/** `brand` may be partial (tests, previews); missing fields take the built-in defaults. */
export function BrandProvider({ brand, children }: { brand: Pick<PublicBrand, 'name'> & Partial<PublicBrand>; children: React.ReactNode }) {
  const value = useMemo(() => ({ ...DEFAULT_PUBLIC_BRAND, ...brand }), [brand])
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>
}

export function useBrand(): PublicBrand {
  return useContext(BrandContext)
}
