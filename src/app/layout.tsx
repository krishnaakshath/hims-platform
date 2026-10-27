import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
// Fonts ship inside the `geist` npm package (next/font/local): no request to
// Google Fonts at build or run time, so the image builds and runs offline.
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrandProvider } from "@/components/BrandProvider";
import { brandThemeCss } from "@/lib/brand";
import { brandIconPalette } from "@/lib/brand-icon";
import { toPublicBrand } from "@/lib/brand-resolve";
import { getBrand } from "@/lib/brand-server";
import "./globals.css";

// WL T4: the brand lives in the database (Settings > Branding), so the root
// layout, its metadata and its viewport render per request (`connection()`):
// no page is ever prerendered with a stale brand, and rebranding needs no
// rebuild. getBrand() is tag-cached and never throws (env brand on failure).

// Next escapes metadata values when it writes <title>/<meta>, and the brand
// text is control-character-stripped and length-capped. Icons come from the
// src/app/icon.tsx / apple-icon.tsx file conventions, not from here.
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const b = await getBrand();
  return { title: b.name, description: b.tagline };
}

// Browser chrome tint (mobile Safari/Chrome, installed PWA) follows the same
// brand colour as the favicon tile; a deep shade of it under dark UI.
export async function generateViewport(): Promise<Viewport> {
  await connection();
  const b = await getBrand();
  const iconPalette = brandIconPalette({ primaryColor: b.accent?.input ?? null });
  return {
    themeColor: [
      { media: "(prefers-color-scheme: light)", color: iconPalette.themeColorLight },
      { media: "(prefers-color-scheme: dark)", color: iconPalette.themeColorDark },
    ],
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const b = await getBrand();
  // Built only from validated #rrggbb values (see brandThemeCss), so it can
  // never carry anything but a colour into this <style> tag.
  const themeCss = brandThemeCss(b.accent);
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
    >
      {themeCss ? (
        <head>
          <style id="brand-theme">{themeCss}</style>
        </head>
      ) : null}
      <body className="min-h-full flex flex-col">
        <BrandProvider brand={toPublicBrand(b)}>
          <TooltipProvider>{children}</TooltipProvider>
        </BrandProvider>
      </body>
    </html>
  );
}
