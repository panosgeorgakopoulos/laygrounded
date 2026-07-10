import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  display: "swap",
  weight: ["300", "400", "500", "600", "700"],
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
      <body className={`${inter.variable} ${jetbrainsMono.variable} ${spaceGrotesk.variable}`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
