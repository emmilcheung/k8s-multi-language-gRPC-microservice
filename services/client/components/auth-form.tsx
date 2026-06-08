"use client";

import { useActionState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Mail, Lock, AlertCircle, ArrowRight, Loader2 } from "lucide-react";
import type { AuthState } from "@/app/actions/auth";

interface AuthFormProps {
  mode: "signup" | "signin";
  action: (_prev: AuthState, formData: FormData) => Promise<AuthState>;
  /** After successful signin, redirect to this URL (passed as a hidden field). */
  next?: string;
}

const initialState: AuthState = {};

export function AuthForm({ mode, action, next }: AuthFormProps) {
  const [state, formAction, pending] = useActionState(action, initialState);

  const isSignup = mode === "signup";
  const title = isSignup ? "Create your account" : "Welcome back";
  const subtitle = isSignup
    ? "Create your Stagepass account with email and password to unlock faster checkout and mobile passes."
    : "Sign in to find tickets, pay faster, and access your passes.";
  const submitLabel = isSignup ? "Sign Up" : "Sign In";
  const tabs = [
    { href: "/auth/signin", label: "Sign in", active: !isSignup },
    { href: "/auth/signup", label: "Create account", active: isSignup },
  ];

  return (
    <div className="flex w-full max-w-md flex-col">
      <div className="mb-7 inline-flex w-fit rounded-lg border border-line bg-subtle p-1">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={tab.active ? "page" : undefined}
            className={cn(
              "rounded-md px-4 py-2 text-sm font-medium transition-colors",
              tab.active ? "bg-card text-ink shadow-sm" : "text-mute hover:text-ink"
            )}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      <div className="space-y-2">
        <h1 className="text-[28px] font-semibold tracking-[-0.022em] text-ink">{title}</h1>
        <p className="text-sm leading-6 text-mute">{subtitle}</p>
      </div>

      <div className="mt-8 rounded-2xl border border-line bg-card p-6 shadow-sm sm:p-7">
        {state?.error && (
          <Alert variant="destructive" className="mb-5">
            <AlertCircle />
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}

        <form action={formAction} className="flex flex-col gap-4">
          {next && <input type="hidden" name="next" value={next} />}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email" className="text-xs font-semibold uppercase tracking-wider text-mute">
              Email
            </Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-mute pointer-events-none" />
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete={isSignup ? "email" : "username"}
                required
                placeholder="you@example.com"
                className="pl-9"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password" className="text-xs font-semibold uppercase tracking-wider text-mute">
              Password
            </Label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-mute pointer-events-none" />
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={isSignup ? "new-password" : "current-password"}
                required
                placeholder="••••••••"
                minLength={isSignup ? 8 : undefined}
                className="pl-9"
              />
            </div>
            {isSignup && (
              <p className="text-xs text-mute">Minimum 8 characters</p>
            )}
          </div>

          <Button
            type="submit"
            className="mt-2 h-11 w-full font-semibold"
            disabled={pending}
          >
            {pending ? (
              <>
                <Loader2 data-icon="inline-start" className="animate-spin" />
                Please wait…
              </>
            ) : (
              <>
                {submitLabel}
                <ArrowRight data-icon="inline-end" />
              </>
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
