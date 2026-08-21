import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Recoup — Revenue Recovery Agent",
  description:
    "A bounded revenue-recovery agent for Razorpay merchants: recovers more money than naive retries, and can't misbehave with money — every action bounded, gated, idempotent, and auditable.",
};

// Typed explicitly rather than with Next's generated `LayoutProps<"/">` global,
// which only exists after a build — this keeps `npm run typecheck` working on a
// fresh clone (and in CI) before anything has been built.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
