import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { NavBar } from "@/components/nav-bar";
import { currentTraceId } from "@/lib/tracing";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Ticketing — Buy & Sell Event Tickets",
  description: "The marketplace for live event tickets.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const traceId = currentTraceId();

  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <head>
        {traceId ? <meta name="x-trace-id" content={traceId} /> : null}
      </head>
      <body className="min-h-full flex flex-col bg-bg text-ink selection:bg-accent/20 selection:text-accent">
        <NavBar />
        <main className="flex-1 container mx-auto max-w-6xl px-4 pb-24 pt-6 md:py-10">
          {children}
        </main>

        <footer className="mb-14 border-t border-line py-8 md:mb-0">
          <div className="container mx-auto px-4 max-w-6xl flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-mute">
            <span className="font-sans font-semibold text-ink text-sm tracking-tight">
              MARQUEE
            </span>
            <span>© {new Date().getFullYear()} Ticketing Platform · All events welcome</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
