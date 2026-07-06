import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "LayGrounded — Laytime & Demurrage Claims Engine",
  description:
    "Automated Statement of Facts extraction with legally auditable clause-matching for dry bulk shipping. $8–10B in dry bulk demurrage annually. LayGrounded turns paper SoFs into arbitrated claims in minutes.",
  keywords: [
    "laytime",
    "demurrage",
    "despatch",
    "dry bulk shipping",
    "GENCON 94",
    "statement of facts",
    "laytime calculation",
    "maritime claims",
    "charter party",
  ],
  authors: [{ name: "LayGrounded" }],
  openGraph: {
    title: "LayGrounded — Laytime & Demurrage Claims Engine",
    description:
      "Precision Laytime Arbitration for Global Bulk Fleets. Automated SoF extraction with legally auditable clause-matching.",
    siteName: "LayGrounded",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "LayGrounded — Laytime & Demurrage Claims Engine",
    description:
      "Automated SoF extraction with legally auditable clause-matching for dry bulk shipping.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} antialiased`}
      >
        <Providers>{children}</Providers>
        <Toaster />
        <SonnerToaster />
      </body>
    </html>
  );
}
