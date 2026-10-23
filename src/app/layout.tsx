import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrandProvider } from "@/components/BrandProvider";
import { brand, brandThemeCss, publicBrand } from "@/lib/brand";
import { brandIconPalette } from "@/lib/brand-icon";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Next escapes metadata values when it writes <title>/<meta>, and brand.ts has
// already stripped control characters and capped the lengths.
export const metadata: Metadata = {
  title: brand.name,
  description: brand.tagline,
};

// Browser chrome tint (mobile Safari/Chrome, installed PWA) follows the same
// brand colour as the favicon tile; a deep shade of it under dark UI.
const iconPalette = brandIconPalette({ primaryColor: brand.primaryColor });
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: iconPalette.themeColorLight },
    { media: "(prefers-color-scheme: dark)", color: iconPalette.themeColorDark },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Built only from the regex-validated #hex colour (see brandThemeCss), so it
  // can never carry anything but a colour into this <style> tag.
  const themeCss = brandThemeCss(brand);
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {themeCss ? (
        <head>
          <style id="brand-theme">{themeCss}</style>
        </head>
      ) : null}
      <body className="min-h-full flex flex-col">
        <BrandProvider brand={publicBrand(brand)}>
          <TooltipProvider>{children}</TooltipProvider>
        </BrandProvider>
      </body>
    </html>
  );
}
