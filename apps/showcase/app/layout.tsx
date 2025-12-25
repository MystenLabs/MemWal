import type React from "react"
import type { Metadata } from "next"
import { Suspense } from "react"
import "./globals.css"
import { SpeedInsights } from "@vercel/speed-insights/next"
import { Dancing_Script, Caveat, Pixelify_Sans } from "next/font/google"
import Npm from "@/components/npm"
import { SuiProviders } from "@/components/providers/SuiProviders"

const PixelifySans = Pixelify_Sans({
  subsets: ["latin"],
  variable: "--font-pixelify-sans",
  display: "swap",
})

const dancingScript = Dancing_Script({
  subsets: ["latin"],
  variable: "--font-dancing-script",
  display: "swap",
})

const caveat = Caveat({
  subsets: ["latin"],
  variable: "--font-caveat",
  display: "swap",
})

export const metadata: Metadata = {
  title: "MemWal - your decentralized memory ",
  description:
    "Decentralized your personal data on Walrus",
  generator: "v0.app",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`font-sans antialiased ${PixelifySans.variable} ${dancingScript.variable} ${caveat.variable}`}>
        <SuiProviders>
          <Suspense fallback={null}>
            {children}
            <Npm />
          </Suspense>
        </SuiProviders>
        <SpeedInsights />
      </body>
    </html>
  )
}
