import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { cookies } from "next/headers";
import { NavBar } from "@/components/nav-bar";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
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
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground selection:bg-primary/30">
        {/* Ambient gradient blobs */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
        >
          <div className="absolute -top-40 -right-40 h-[600px] w-[600px] rounded-full bg-primary/10 blur-[120px]" />
          <div className="absolute top-1/2 -left-60 h-[500px] w-[500px] rounded-full bg-violet-900/20 blur-[100px]" />
          <div className="absolute bottom-0 right-1/4 h-[400px] w-[400px] rounded-full bg-indigo-900/15 blur-[100px]" />
        </div>

        <NavBar isLoggedIn={isLoggedIn} />
        <main className="flex-1 container mx-auto px-4 py-10 max-w-6xl">
          {children}
        </main>

        <footer className="border-t border-white/5 py-6 text-center text-xs text-muted-foreground">
          © {new Date().getFullYear()} Ticketing Platform
        </footer>
      </body>
    </html>
  );
}
