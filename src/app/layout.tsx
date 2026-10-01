import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ErrorReporter } from "@/components/error-reporter";
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
  title: "Tillflow POS",
  description: "Cloud, offline-capable point of sale for Irish shops, cafés and restaurants.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <ErrorReporter />
        {children}
      </body>
    </html>
  );
}
