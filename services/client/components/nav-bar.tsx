"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button-variants";
import { Button } from "@/components/ui/button";
import { signout } from "@/app/actions/auth";
import { cn } from "@/lib/utils";
import {
  Tag,
  Building2,
  LayoutDashboard,
  LogOut,
  LogIn,
  UserPlus,
  Settings,
  Home,
} from "lucide-react";

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
    <header className="sticky top-0 z-50 bg-background border-b border-border">
      <div className="container mx-auto px-4 max-w-6xl h-14 flex items-center justify-between gap-4">
        {/* Brand */}
        <Link href="/" className="flex items-center gap-2.5 group shrink-0">
          <span className="flex items-center justify-center size-7 rounded bg-primary">
            <span className="text-primary-foreground font-display font-extrabold text-xs tracking-widest leading-none">
              M
            </span>
          </span>
          <span className="font-display font-extrabold text-sm tracking-[0.12em] uppercase text-foreground">
            Marquee
          </span>
        </Link>

        {/* Desktop nav */}
        <nav
          className={cn(
            "hidden md:flex items-center gap-0.5 transition-opacity",
            mounted ? "opacity-100" : "opacity-0"
          )}
        >
          {isLoggedIn ? (
            <>
              <Link
                href="/tickets/new"
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "gap-1.5 text-muted-foreground hover:text-foreground text-xs font-medium"
                )}
              >
                <Tag className="size-3.5" />
                Sell
              </Link>
              <Link
                href="/venues"
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "gap-1.5 text-muted-foreground hover:text-foreground text-xs font-medium"
                )}
              >
                <Building2 className="size-3.5" />
                Venues
              </Link>
              <Link
                href="/orders"
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "gap-1.5 text-muted-foreground hover:text-foreground text-xs font-medium"
                )}
              >
                <LayoutDashboard className="size-3.5" />
                Orders
              </Link>
              <Link
                href="/settings"
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "gap-1.5 text-muted-foreground hover:text-foreground text-xs font-medium"
                )}
              >
                <Settings className="size-3.5" />
                Settings
              </Link>
              <form action={signout} className="ml-1">
                <Button
                  type="submit"
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground hover:text-foreground text-xs font-medium"
                >
                  <LogOut className="size-3.5" />
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
                  "gap-1.5 text-muted-foreground hover:text-foreground text-xs font-medium"
                )}
              >
                <LogIn className="size-3.5" />
                Sign In
              </Link>
              <Link
                href="/auth/signup"
                className={cn(
                  buttonVariants({ size: "sm" }),
                  "gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold ml-1"
                )}
              >
                <UserPlus className="size-3.5" />
                Sign Up
              </Link>
            </>
          )}
        </nav>
      </div>

      {/* Mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/95 backdrop-blur md:hidden">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-around px-2">
          {isLoggedIn ? (
            <>
              <Link href="/" className="inline-flex flex-col items-center gap-0.5 text-[11px] text-muted-foreground">
                <Home className="size-4" />
                Browse
              </Link>
              <Link href="/tickets/new" className="inline-flex flex-col items-center gap-0.5 text-[11px] text-muted-foreground">
                <Tag className="size-4" />
                Sell
              </Link>
              <Link href="/orders" className="inline-flex flex-col items-center gap-0.5 text-[11px] text-muted-foreground">
                <LayoutDashboard className="size-4" />
                Orders
              </Link>
              <Link href="/settings" className="inline-flex flex-col items-center gap-0.5 text-[11px] text-muted-foreground">
                <Settings className="size-4" />
                Settings
              </Link>
            </>
          ) : (
            <>
              <Link href="/" className="inline-flex flex-col items-center gap-0.5 text-[11px] text-muted-foreground">
                <Home className="size-4" />
                Browse
              </Link>
              <Link href="/auth/signin" className="inline-flex flex-col items-center gap-0.5 text-[11px] text-muted-foreground">
                <LogIn className="size-4" />
                Sign in
              </Link>
              <Link href="/auth/signup" className="inline-flex flex-col items-center gap-0.5 text-[11px] text-muted-foreground">
                <UserPlus className="size-4" />
                Sign up
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
