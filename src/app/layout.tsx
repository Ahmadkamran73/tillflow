import type { Metadata } from "next";
import { Geist_Mono, Instrument_Sans, Mona_Sans } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { ErrorReporter } from "@/components/error-reporter";
import { t } from "@/lib/i18n";
import "./globals.css";

const instrument = Instrument_Sans({
  variable: "--font-instrument",
  subsets: ["latin"],
});

const mona = Mona_Sans({
  variable: "--font-mona",
  subsets: ["latin"],
  axes: ["wdth"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: t("app.name"),
  description: "Cloud, offline-capable point of sale for Irish shops, cafés and restaurants.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en-IE"
      className={`${instrument.variable} ${mona.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <ErrorReporter />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
