"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
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
  const title = isSignup ? "Create an account" : "Welcome back";
  const subtitle = isSignup
    ? "Join thousands buying and selling event tickets"
    : "Sign in to your Marquee account";
  const submitLabel = isSignup ? "Sign Up" : "Sign In";
  const altText = isSignup ? "Already have an account?" : "Don't have an account?";
  const altHref = isSignup ? "/auth/signin" : "/auth/signup";
  const altLabel = isSignup ? "Sign in" : "Sign up";

  return (
    <div className="w-full max-w-sm flex flex-col gap-8">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-block h-px w-6 bg-primary" />
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            {isSignup ? "New Account" : "Sign In"}
          </span>
        </div>
        <h1 className="font-display font-extrabold text-2xl tracking-tight text-foreground">
          {title}
        </h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>

      {/* Form card */}
      <div className="bg-card border border-border rounded-lg p-6 flex flex-col gap-5 shadow-sm">
        {state?.error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}

        <form action={formAction} className="flex flex-col gap-4">
          {/* Hidden field carries the post-login redirect URL for OAuth flows */}
          {next && <input type="hidden" name="next" value={next} />}
          {/* Email */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Email
            </Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete={isSignup ? "email" : "username"}
                required
                placeholder="you@example.com"
                className="pl-9 bg-background border-border focus:border-primary"
              />
            </div>
          </div>

          {/* Password */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Password
            </Label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={isSignup ? "new-password" : "current-password"}
                required
                placeholder="••••••••"
                minLength={isSignup ? 8 : undefined}
                className="pl-9 bg-background border-border focus:border-primary"
              />
            </div>
            {isSignup && (
              <p className="text-xs text-muted-foreground">Minimum 8 characters</p>
            )}
          </div>

          <Button
            type="submit"
            className="w-full mt-1 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
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

        <Separator />

        <p className="text-sm text-muted-foreground text-center">
          {altText}{" "}
          <Link
            href={altHref}
            className="text-primary font-semibold hover:underline underline-offset-2 transition-colors"
          >
            {altLabel}
          </Link>
        </p>
      </div>
    </div>
  );
}
