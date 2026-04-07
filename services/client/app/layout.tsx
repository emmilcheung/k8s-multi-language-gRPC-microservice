import type { Metadata } from "next";
import { Syne, DM_Sans } from "next/font/google";
import "./globals.css";
import { cookies } from "next/headers";
import { NavBar } from "@/components/nav-bar";
import { currentTraceId } from "@/lib/tracing";

const syne = Syne({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
  display: "swap",
});

const dmSans = DM_Sans({
  variable: "--font-sans",
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
  const cookieStore = await cookies();
  const isLoggedIn = Boolean(cookieStore.get("token")?.value);
  const traceId = currentTraceId();

  return (
    <html
      lang="en"
      className={`${syne.variable} ${dmSans.variable} h-full antialiased`}
    >
      <head>
        {traceId ? <meta name="x-trace-id" content={traceId} /> : null}
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground selection:bg-primary/20 selection:text-primary">
        <NavBar isLoggedIn={isLoggedIn} />
        <main className="flex-1 container mx-auto px-4 py-10 max-w-6xl">
          {children}
        </main>

        <footer className="border-t border-border py-8">
          <div className="container mx-auto px-4 max-w-6xl flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
            <span className="font-display font-700 text-foreground text-sm tracking-tight">
              MARQUEE
            </span>
            <span>© {new Date().getFullYear()} Ticketing Platform · All events welcome</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
