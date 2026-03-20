"use client";
// components/auth-form.tsx — Shared Client Component for signup/signin.
// Glass card with Lucide icon-prefixed inputs and rich error state.

import { useActionState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Ticket, Mail, Lock, AlertCircle, ArrowRight, Loader2 } from "lucide-react";
import type { AuthState } from "@/app/actions/auth";

interface AuthFormProps {
  mode: "signup" | "signin";
  action: (_prev: AuthState, formData: FormData) => Promise<AuthState>;
}

const initialState: AuthState = {};

export function AuthForm({ mode, action }: AuthFormProps) {
  const [state, formAction, pending] = useActionState(action, initialState);

  const isSignup = mode === "signup";
  const title = isSignup ? "Create an account" : "Welcome back";
  const subtitle = isSignup
    ? "Join thousands buying and selling event tickets"
    : "Sign in to your Ticketing account";
  const submitLabel = isSignup ? "Sign Up" : "Sign In";
  const altText = isSignup ? "Already have an account?" : "Don't have an account?";
  const altHref = isSignup ? "/auth/signin" : "/auth/signup";
  const altLabel = isSignup ? "Sign in" : "Sign up";

  return (
    <div className="glass rounded-2xl w-full max-w-sm p-8 flex flex-col gap-6">
      {/* Brand header */}
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-primary/15 ring-1 ring-primary/30">
          <Ticket className="w-6 h-6 text-primary" />
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-bold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
      </div>

      {/* Divider */}
      <div className="h-px bg-white/6" />

      <form action={formAction} className="flex flex-col gap-4">
        {/* Error alert */}
        {state?.error && (
          <div
            role="alert"
            className="flex items-start gap-2.5 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{state.error}</span>
          </div>
        )}

        {/* Email */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Email
          </Label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
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

        {/* Password */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Password
          </Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
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
            <p className="text-xs text-muted-foreground pl-0.5">Minimum 8 characters</p>
          )}
        </div>

        {/* Submit */}
        <Button
          type="submit"
          className="w-full gap-2 bg-primary hover:bg-primary/90 text-primary-foreground mt-1"
          disabled={pending}
        >
          {pending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Please wait…
            </>
          ) : (
            <>
              {submitLabel}
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </Button>
      </form>

      {/* Alt link */}
      <p className="text-sm text-muted-foreground text-center">
        {altText}{" "}
        <Link href={altHref} className="text-primary hover:text-primary/80 underline underline-offset-2 transition-colors">
          {altLabel}
        </Link>
      </p>
    </div>
  );
}
