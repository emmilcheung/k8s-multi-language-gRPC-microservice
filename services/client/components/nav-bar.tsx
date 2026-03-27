// components/nav-bar.tsx — Glassmorphism top navigation (Client Component).
// Auth state is derived server-side (token httpOnly cookie) and passed as a prop.

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button-variants";
import { Button } from "@/components/ui/button";
import { signout } from "@/app/actions/auth";
import { cn } from "@/lib/utils";
import { Ticket, LayoutDashboard, LogOut, LogIn, UserPlus, Tag } from "lucide-react";

interface NavBarProps {
  isLoggedIn: boolean;
}

export function NavBar({ isLoggedIn }: NavBarProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  return (
    <header className="sticky top-0 z-50 border-b border-white/8 bg-background/60 backdrop-blur-xl">
      <div className="container mx-auto px-4 max-w-6xl h-16 flex items-center justify-between gap-4">
        {/* Brand */}
        <Link href="/" className="flex items-center gap-2 group shrink-0">
          <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/20 ring-1 ring-primary/30 group-hover:bg-primary/30 transition-colors">
            <Ticket className="w-4 h-4 text-primary" />
          </span>
          <span className="font-semibold text-base tracking-tight gradient-text">
            Ticketing
          </span>
        </Link>

        {/* Nav links — hidden until mounted to avoid hydration flash */}
        <nav className={cn("flex items-center gap-1 transition-opacity", mounted ? "opacity-100" : "opacity-0")}>
          {isLoggedIn ? (
            <>
              <Link
                href="/tickets/new"
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "gap-1.5 text-muted-foreground hover:text-foreground"
                )}
              >
                <Tag className="w-3.5 h-3.5" />
                Sell
              </Link>
              <Link
                href="/orders"
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "gap-1.5 text-muted-foreground hover:text-foreground"
                )}
              >
                <LayoutDashboard className="w-3.5 h-3.5" />
                My Orders
              </Link>
              <form action={signout}>
                <Button
                  type="submit"
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground hover:text-foreground"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Sign Out
                </Button>
              </form>
            </>
          ) : (
            <>
              <Link
                href="/auth/signin"
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "gap-1.5 text-muted-foreground hover:text-foreground"
                )}
              >
                <LogIn className="w-3.5 h-3.5" />
                Sign In
              </Link>
              <Link
                href="/auth/signup"
                className={cn(
                  buttonVariants({ size: "sm" }),
                  "gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground"
                )}
              >
                <UserPlus className="w-3.5 h-3.5" />
                Sign Up
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
